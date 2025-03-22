import express from 'express';
import cors from 'cors';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { createClient } from 'redis';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({
    origin: ["https://www.motivationkaksha.com", "https://motivationkaksha.com", "http://127.0.0.1:5500"],
    credentials: true
}));

// Initialize Redis client for caching
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
    try {
        await redisClient.connect();
        console.log('Redis connected successfully');
    } catch (error) {
        console.error('Redis connection failed:', error);
    }
})();

// Initialize PostgreSQL Pool
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

// Filter endpoint
app.post('/filter', async (req, res) => {
    const { 
        institute, 
        AcademicProgramName, 
        quota, 
        SeatType,
        gender, 
        userRank,
        Year,
        round
    } = req.body;

    if (userRank) {
    // More strict validation to ensure it's only digits
    if (!/^\d+$/.test(userRank)) {
        return res.status(400).json({
            success: false,
            message: "User rank must be a valid integer number"
        });
    }
    
    // Now safe to convert to integer
    const userRankInt = parseInt(userRank, 10);

    const cacheKey = `filter:${JSON.stringify(req.body)}`;

    try {
        if (redisClient.isReady) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                console.log('Serving filter results from cache');
                return res.status(200).json(JSON.parse(cachedData));
            }
        }

        let filterQuery = `
            SELECT *, ABS(NULLIF("Opening Rank", '')::INTEGER - $1) AS rank_diff
            FROM public.combined_josaa_in
            WHERE 1=1
        `;
        const params = [userRank ? parseInt(userRank) : 0];
        let paramIndex = 2;

        if (institute) {
            filterQuery += ` AND "Institute" ILIKE $${paramIndex}`;
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
            filterQuery += ` AND "Quota" = $${paramIndex}`;
            params.push(quota);
            paramIndex++;
        }
        if (SeatType) {
            filterQuery += ` AND "Seat Type" = $${paramIndex}`;
            params.push(SeatType);
            paramIndex++;
        }
        if (gender) {
            filterQuery += ` AND "Gender" = $${paramIndex}`;
            params.push(gender);
            paramIndex++;
        }
        if (round) {
            filterQuery += ` AND "Round" = $${paramIndex}`;
            params.push(round);
            paramIndex++;
        }

        if (userRank) {
            filterQuery += ` AND NULLIF("Opening Rank", '')::INTEGER <= $${paramIndex} 
                             AND NULLIF("Closing Rank", '')::INTEGER >= $${paramIndex}`;
            params.push(userRank);
            paramIndex++;
            filterQuery += ` ORDER BY rank_diff ASC `;
        } else {
            filterQuery += ` ORDER BY NULLIF("Opening Rank", '')::INTEGER ASC `;
        }

        filterQuery += ` LIMIT 50`;

        const result = await pool.query(filterQuery, params);
        const responseData = {
            success: true,
            count: result.rows.length,
            message: result.rows.length === 0 ? "No matches found for the given criteria" : null,
            filterData: result.rows
        };

        if (redisClient.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(responseData), { EX: 3600 });
        }

        res.status(200).json(responseData);
    } catch (error) {
        console.error("Filter error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching data",
            error: error.message
        });
    }
});

// Institute suggestion endpoint
app.get('/suggest', async (req, res) => {
    const { term } = req.query;

    if (!term || term.trim() === '') {
        return res.status(400).json({
            success: false,
            message: "Please enter a search term"
        });
    }

    const cacheKey = `suggest:${term}`;

    try {
        if (redisClient.isReady) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                console.log('Serving suggestions from cache');
                return res.json(JSON.parse(cachedData));
            }
        }

        const query = `
            SELECT DISTINCT "Institute"
            FROM public.combined_josaa_in
            WHERE "Institute" ILIKE $1
            ORDER BY "Institute" ASC
            LIMIT 10
        `;
        const result = await pool.query(query, [`%${term}%`]);
        const suggestions = result.rows.map(r => r.Institute);

        if (redisClient.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(suggestions), { EX: 1800 });
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

// Program suggestion endpoint
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
        
        if (redisClient.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(programs), { EX: 1800 });
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

// Rank trends endpoint
app.post('/rank-trends', async (req, res) => {
    const { institute, program, SeatType, quota, gender } = req.body;
    
    if (!institute && !program) {
        return res.status(400).json({
            success: false,
            message: "Please provide at least institute or program name"
        });
    }
    
    const cacheKey = `rank-trends:${JSON.stringify(req.body)}`;
    
    try {
        if (redisClient.isReady) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                return res.status(200).json(JSON.parse(cachedData));
            }
        }
        
        let query = `
            SELECT "Year", "Round", 
                   NULLIF("Opening Rank", '')::INTEGER AS "Opening Rank", 
                   NULLIF("Closing Rank", '')::INTEGER AS "Closing Rank"
            FROM public.combined_josaa_in
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;
        
        if (institute) {
            query += ` AND "Institute" = $${paramIndex}`;
            params.push(institute);
            paramIndex++;
        }
        
        if (program) {
            query += ` AND "Academic Program Name" = $${paramIndex}`;
            params.push(program);
            paramIndex++;
        }
        
        if (SeatType) {
            query += ` AND "Seat Type" = $${paramIndex}`;
            params.push(SeatType);
            paramIndex++;
        }
        
        if (quota) {
            query += ` AND "Quota" = $${paramIndex}`;
            params.push(quota);
            paramIndex++;
        }
        
        if (gender) {
            query += ` AND "Gender" = $${paramIndex}`;
            params.push(gender);
            paramIndex++;
        }
        
        query += ` ORDER BY "Year" ASC, "Round" ASC`;
        
        const result = await pool.query(query, params);
        
        const responseData = {
            success: true,
            message: result.rows.length === 0 ? "No trend data found for the given criteria" : null,
            data: result.rows
        };
        
        if (redisClient.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(responseData), { EX: 3600 });
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

// Probability prediction endpoint
app.post('/predict-probability', async (req, res) => {
    const { userRank, institute, program, SeatType, quota, gender } = req.body;
    
    if (!userRank || isNaN(Number(userRank))) {
        return res.status(400).json({
            success: false,
            message: "Valid user rank is required"
        });
    }
    
    const cacheKey = `predict-probability:${JSON.stringify(req.body)}`;
    
    try {
        if (redisClient.isReady) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                return res.status(200).json(JSON.parse(cachedData));
            }
        }
        
        // Get last 3 years of data for this program/institute with proper casts
        let query = `
            SELECT "Year", 
                   NULLIF("Opening Rank", '')::INTEGER AS "Opening Rank", 
                   NULLIF("Closing Rank", '')::INTEGER AS "Closing Rank"
            FROM public.combined_josaa_in
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;
        
        if (institute) {
            query += ` AND "Institute" = $${paramIndex}`;
            params.push(institute);
            paramIndex++;
        }
        
        if (program) {
            query += ` AND "Academic Program Name" = $${paramIndex}`;
            params.push(program);
            paramIndex++;
        }
        
        if (SeatType) {
            query += ` AND "Seat Type" = $${paramIndex}`;
            params.push(SeatType);
            paramIndex++;
        }
        
        if (quota) {
            query += ` AND "Quota" = $${paramIndex}`;
            params.push(quota);
            paramIndex++;
        }
        
        if (gender) {
            query += ` AND "Gender" = $${paramIndex}`;
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
        
        let probability = 0;
        const rankNum = Number(userRank);
        
        // Simple probability estimation algorithm using historical data
        result.rows.forEach(row => {
            const openRank = Number(row["Opening Rank"]);
            const closeRank = Number(row["Closing Rank"]);
            
            if (rankNum <= closeRank) {
                if (rankNum <= openRank) {
                    probability += 0.95;
                } else {
                    const position = (rankNum - openRank) / (closeRank - openRank);
                    probability += 0.95 - (position * 0.45); // adjusts between 0.95 and 0.5
                }
            } else {
                const difference = rankNum - closeRank;
                const threshold = closeRank * 0.1;
                
                if (difference <= threshold) {
                    probability += 0.3 * (1 - (difference / threshold));
                } else {
                    probability += 0.05;
                }
            }
        });
        
        probability = probability / result.rows.length;
        
        const responseData = {
            success: true,
            probability: Math.min(Math.round(probability * 100) / 100, 0.99),
            historicalData: result.rows
        };
        
        if (redisClient.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(responseData), { EX: 3600 });
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

// Filter options endpoint
app.get('/filter-options', async (req, res) => {
    const cacheKey = 'filter-options';
    
    try {
        if (redisClient.isReady) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                return res.status(200).json(JSON.parse(cachedData));
            }
        }
        
        // Get distinct values for filter options
        const yearsResult = await pool.query(
            'SELECT DISTINCT "Year" FROM public.combined_josaa_in ORDER BY "Year" DESC'
        );
        const quotasResult = await pool.query(
            'SELECT DISTINCT "Quota" FROM public.combined_josaa_in ORDER BY "Quota" ASC'
        );
        const seatTypesResult = await pool.query(
            'SELECT DISTINCT "Seat Type" FROM public.combined_josaa_in ORDER BY "Seat Type" ASC'
        );
        const gendersResult = await pool.query(
            'SELECT DISTINCT "Gender" FROM public.combined_josaa_in ORDER BY "Gender" ASC'
        );
        const roundsResult = await pool.query(
            'SELECT DISTINCT "Round" FROM public.combined_josaa_in ORDER BY "Round" ASC'
        );
        
        const options = {
            years: yearsResult.rows.map(row => row.Year),
            quotas: quotasResult.rows.map(row => row.Quota),
            seatTypes: seatTypesResult.rows.map(row => row["Seat Type"]),
            genders: gendersResult.rows.map(row => row.Gender),
            rounds: roundsResult.rows.map(row => row.Round)
        };
        
        if (redisClient.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(options), { EX: 86400 });
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
