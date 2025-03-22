import express from 'express';
import cors from 'cors';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { createClient } from 'redis'; // You'll need to install: npm install redis

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({
    origin: ["https://www.motivationkaksha.com", "https://motivationkaksha.com"],
    credentials: true
}));

// Initialize Redis client for caching
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

(async () => {
    try {
        await redisClient.connect();
        console.log('Redis connected successfully');
    } catch (error) {
        console.error('Redis connection failed:', error);
    }
})();

const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.DB_PORT,
    ssl: true,
});

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.status(200).json({
            success: true,
            database: "connected",
            redis: redisClient.isReady ? "connected" : "disconnected",
            timestamp: result.rows[0].now
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            database: "disconnected",
            redis: redisClient.isReady ? "connected" : "disconnected",
            error: error.message
        });
    }
});

// Main filter endpoint with caching
app.post('/filter', async (req, res) => {
    const { 
        institute, 
        AcademicProgramName, 
        quota, 
        SeatType,
        gender, 
        userRank,
        Year,
        round,
    } = req.body;

    // Input validation
    if (userRank && isNaN(Number(userRank))) {
        return res.status(400).json({
            success: false,
            message: "User rank must be a number"
        });
    }

    // Create cache key from request parameters
    const cacheKey = `filter:${JSON.stringify(req.body)}`;
    
    try {
        // Try to get data from cache first
        if (redisClient.isReady) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                console.log('Serving filter results from cache');
                return res.status(200).json(JSON.parse(cachedData));
            }
        }

        // Build the query
        let filterQuery = `
            SELECT *, ABS("Opening Rank" - $1) AS rank_diff 
            FROM public.combined_josaa_in 
            WHERE 1=1
        `;
        const params = [userRank || 0]; // Default to 0 if no rank provided
        let paramIndex = 2;
        
        if (institute) {
            filterQuery += ` AND "institute" ILIKE $${paramIndex}`;
            params.push(`%${institute}%`);
            paramIndex++;
        }
        if (AcademicProgramName) {
            filterQuery += ` AND "Academic Program Name" ILIKE $${paramIndex}`;
            params.push(`%${AcademicProgramName}%`);
            paramIndex++;
        }
        if (Year) {
            filterQuery += ` AND "Year" = $${paramIndex}`;
            params.push(Year);
            paramIndex++;
        }
        if (quota) {
            filterQuery += ` AND "quota" = $${paramIndex}`;
            params.push(quota);
            paramIndex++;
        }
        if (SeatType) {
            filterQuery += ` AND "Seat Type" = $${paramIndex}`;
            params.push(SeatType);
            paramIndex++;
        }
        if (gender) {
            filterQuery += ` AND "gender" = $${paramIndex}`;
            params.push(gender);
            paramIndex++;
        }
        if (round) {
            filterQuery += ` AND "round" = $${paramIndex}`;
            params.push(round);
            paramIndex++;
        }
        
        // Add rank filtering if provided
        if (userRank) {
            filterQuery += ` AND "Opening Rank" <= $${paramIndex} AND "Closing Rank" >= $${paramIndex}`;
            params.push(userRank);
            paramIndex++;
            filterQuery += ` ORDER BY rank_diff ASC `;
        } else {
            filterQuery += ` ORDER BY "Opening Rank" ASC `;
        }
        
        // Add limit for better performance
        filterQuery += ` LIMIT 50`;
        
        const result = await pool.query(filterQuery, params);
        
        // Prepare response
        const responseData = {
            success: true,
            count: result.rows.length,
            message: result.rows.length === 0 ? "No matches found for the given criteria" : null,
            filterData: result.rows
        };
        
        // Cache the result if Redis is connected
        if (redisClient.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(responseData), { EX: 3600 }); // Cache for 1 hour
        }
        
        res.status(200).json(responseData);
    } catch (error) {
        console.error("Filter error:", error);
        res.status(500).json({
            success: false,
            message: "Error in fetching data",
            error: error.message
        });
    }
});

// Institute suggestion endpoint (fixed SQL injection vulnerability)
app.get('/suggest', async (req, res) => {
    const { term } = req.query;
    
    if (!term || term.trim() === '') {
        return res.status(400).json({
            success: false,
            message: "Please enter a search term"
        });
    }
    
    // Create cache key
    const cacheKey = `suggest:${term}`;
    
    try {
        // Try to get from cache
        if (redisClient.isReady) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                console.log('Serving suggestions from cache');
                return res.json(JSON.parse(cachedData));
            }
        }
        
        // Split search term into individual words
        const searchTerms = term.trim().split(/\s+/);
        
        let query, params;
        
        if (searchTerms.length === 1) {
            query = `
                SELECT DISTINCT institute 
                FROM public.combined_josaa_in
                WHERE institute ILIKE $1
                ORDER BY institute ASC
                LIMIT 10
            `;
            params = [`%${searchTerms[0]}%`];
        } else {
            query = `
                SELECT DISTINCT institute 
                FROM public.combined_josaa_in
                WHERE institute ILIKE $1
                ORDER BY institute ASC
                LIMIT 10
            `;
            params = [`%${searchTerms[1]}%`];
        }
        
        const result = await pool.query(query, params);
        const suggestions = result.rows.map(r => r.institute);
        
        // Cache the result
        if (redisClient.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(suggestions), { EX: 1800 }); // Cache for 30 minutes
        }
        
        res.json(suggestions);
    } catch (error) {
        console.error("Autocomplete error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching suggestions",
            error: error.message
        });
    }
});

// New endpoint: Program suggestion
app.get('/suggest-programs', async (req, res) => {
    const { term } = req.query;
    
    if (!term || term.trim() === '') {
        return res.status(400).json({
            success: false,
            message: "Please enter a search term"
        });
    }
    
    const cacheKey = `suggest-programs:${term}`;
    
    try {
        // Try to get from cache
        if (redisClient.isReady) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                return res.json(JSON.parse(cachedData));
            }
        }
        
        const query = `
            SELECT DISTINCT "Academic Program Name" as program
            FROM public.combined_josaa_in
            WHERE "Academic Program Name" ILIKE $1
            ORDER BY "Academic Program Name" ASC
            LIMIT 10
        `;
        const result = await pool.query(query, [`%${term}%`]);
        const programs = result.rows.map(r => r.program);
        
        // Cache the result
        if (redisClient.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(programs), { EX: 1800 }); // Cache for 30 minutes
        }
        
        res.json(programs);
    } catch (error) {
        console.error("Program suggestion error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching program suggestions",
            error: error.message
        });
    }
});

// New endpoint: Rank trends
app.post('/rank-trends', async (req, res) => {
    const { institute, program, seatType, quota, gender } = req.body;
    
    if (!institute && !program) {
        return res.status(400).json({
            success: false,
            message: "Please provide at least institute or program name"
        });
    }
    
    const cacheKey = `rank-trends:${JSON.stringify(req.body)}`;
    
    try {
        // Try to get from cache
        if (redisClient.isReady) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                return res.status(200).json(JSON.parse(cachedData));
            }
        }
        
        let query = `
            SELECT "Year", "round", "Opening Rank", "Closing Rank"
            FROM public.combined_josaa_in
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;
        
        if (institute) {
            query += ` AND "institute" = $${paramIndex}`;
            params.push(institute);
            paramIndex++;
        }
        
        if (program) {
            query += ` AND "Academic Program Name" = $${paramIndex}`;
            params.push(program);
            paramIndex++;
        }
        
        if (seatType) {
            query += ` AND "Seat Type" = $${paramIndex}`;
            params.push(seatType);
            paramIndex++;
        }
        
        if (quota) {
            query += ` AND "quota" = $${paramIndex}`;
            params.push(quota);
            paramIndex++;
        }
        
        if (gender) {
            query += ` AND "gender" = $${paramIndex}`;
            params.push(gender);
            paramIndex++;
        }
        
        query += ` ORDER BY "Year" ASC, "round" ASC`;
        
        const result = await pool.query(query, params);
        
        const responseData = {
            success: true,
            message: result.rows.length === 0 ? "No trend data found for the given criteria" : null,
            data: result.rows
        };
        
        // Cache the result
        if (redisClient.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(responseData), { EX: 3600 }); // Cache for 1 hour
        }
        
        res.status(200).json(responseData);
    } catch (error) {
        console.error("Rank trends error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching rank trends",
            error: error.message
        });
    }
});

// New endpoint: Probability prediction
app.post('/predict-probability', async (req, res) => {
    const { userRank, institute, program, seatType, quota, gender } = req.body;
    
    if (!userRank || isNaN(Number(userRank))) {
        return res.status(400).json({
            success: false,
            message: "Valid user rank is required"
        });
    }
    
    const cacheKey = `predict-probability:${JSON.stringify(req.body)}`;
    
    try {
        // Try to get from cache
        if (redisClient.isReady) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                return res.status(200).json(JSON.parse(cachedData));
            }
        }
        
        // Get last 3 years of data for this program/institute
        let query = `
            SELECT "Year", "Opening Rank", "Closing Rank"
            FROM public.combined_josaa_in
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;
        
        if (institute) {
            query += ` AND "institute" = $${paramIndex}`;
            params.push(institute);
            paramIndex++;
        }
        
        if (program) {
            query += ` AND "Academic Program Name" = $${paramIndex}`;
            params.push(program);
            paramIndex++;
        }
        
        if (seatType) {
            query += ` AND "Seat Type" = $${paramIndex}`;
            params.push(seatType);
            paramIndex++;
        }
        
        if (quota) {
            query += ` AND "quota" = $${paramIndex}`;
            params.push(quota);
            paramIndex++;
        }
        
        if (gender) {
            query += ` AND "gender" = $${paramIndex}`;
            params.push(gender);
            paramIndex++;
        }
        
        query += ` ORDER BY "Year" DESC LIMIT 3`;
        
        const result = await pool.query(query, params);
        
        if (result.rows.length === 0) {
            const responseData = {
                success: true,
                message: "No historical data found for probability estimation",
                probability: 0,
                historicalData: []
            };
            
            if (redisClient.isReady) {
                await redisClient.set(cacheKey, JSON.stringify(responseData), { EX: 3600 });
            }
            
            return res.status(200).json(responseData);
        }
        
        // Calculate probability based on historical data
        let probability = 0;
        const rankNum = Number(userRank);
        
        // Simple algorithm - can be improved
        result.rows.forEach(row => {
            const openRank = Number(row["Opening Rank"]);
            const closeRank = Number(row["Closing Rank"]);
            
            if (rankNum <= closeRank) {
                // User's rank is within the closing rank - high chance
                if (rankNum <= openRank) {
                    // User's rank is better than opening rank - very high chance
                    probability += 0.95;
                } else {
                    // User's rank is between opening and closing - good chance
                    const position = (rankNum - openRank) / (closeRank - openRank);
                    probability += 0.95 - (position * 0.45); // 0.95 to 0.5 range
                }
            } else {
                // User's rank is outside closing rank
                const difference = rankNum - closeRank;
                const threshold = closeRank * 0.1; // 10% buffer
                
                if (difference <= threshold) {
                    // Within threshold - small chance
                    probability += 0.3 * (1 - (difference / threshold));
                } else {
                    // Outside threshold - very little chance
                    probability += 0.05;
                }
            }
        });
        
        // Average the probability
        probability = probability / result.rows.length;
        
        const responseData = {
            success: true,
            probability: Math.min(Math.round(probability * 100) / 100, 0.99),
            historicalData: result.rows
        };
        
        // Cache the result
        if (redisClient.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(responseData), { EX: 3600 }); // Cache for 1 hour
        }
        
        res.status(200).json(responseData);
    } catch (error) {
        console.error("Probability estimation error:", error);
        res.status(500).json({
            success: false,
            message: "Error calculating probability",
            error: error.message
        });
    }
});

// New endpoint: Get filter options
app.get('/filter-options', async (req, res) => {
    const cacheKey = 'filter-options';
    
    try {
        // Try to get from cache
        if (redisClient.isReady) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                return res.status(200).json(JSON.parse(cachedData));
            }
        }
        
        // Get years
        const yearsResult = await pool.query(
            'SELECT DISTINCT "Year" FROM public.combined_josaa_in ORDER BY "Year" DESC'
        );
        
        // Get quotas
        const quotasResult = await pool.query(
            'SELECT DISTINCT "quota" FROM public.combined_josaa_in ORDER BY "quota" ASC'
        );
        
        // Get seat types
        const seatTypesResult = await pool.query(
            'SELECT DISTINCT "Seat Type" FROM public.combined_josaa_in ORDER BY "Seat Type" ASC'
        );
        
        // Get genders
        const gendersResult = await pool.query(
            'SELECT DISTINCT "gender" FROM public.combined_josaa_in ORDER BY "gender" ASC'
        );
        
        // Get rounds
        const roundsResult = await pool.query(
            'SELECT DISTINCT "round" FROM public.combined_josaa_in ORDER BY "round" ASC'
        );
        
        const options = {
            years: yearsResult.rows.map(row => row.Year),
            quotas: quotasResult.rows.map(row => row.quota),
            seatTypes: seatTypesResult.rows.map(row => row["Seat Type"]),
            genders: gendersResult.rows.map(row => row.gender),
            rounds: roundsResult.rows.map(row => row.round)
        };
        
        // Cache the result (longer duration as this rarely changes)
        if (redisClient.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(options), { EX: 86400 }); // Cache for 24 hours
        }
        
        res.status(200).json(options);
    } catch (error) {
        console.error("Filter options error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching filter options",
            error: error.message
        });
    }
});

// Global error handler middleware
app.use((err, req, res, next) => {
    console.error("Global error:", err);
    res.status(500).json({
        success: false,
        message: "An unexpected error occurred",
        error: process.env.NODE_ENV === 'production' ? 'Server error' : err.message
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
