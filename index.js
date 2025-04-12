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
    port: process.env.PGPORT || process.env.DB_PORT, // Fixed inconsistent port env var name
    ssl: process.env.NODE_ENV === 'production' ? true : false, // Only use SSL in production
});

// Helper function to cache response with better error handling
async function cacheResponse(key, data, expirationSeconds = 3600) {
    if (!redisClient.isReady) return;
    
    try {
        await redisClient.set(key, JSON.stringify(data), { EX: expirationSeconds })
            .catch(err => console.warn(`Cache storage failed for key ${key}:`, err.message));
    } catch (err) {
        console.warn(`Cache attempt failed for key ${key}:`, err.message);
    }
}

// Helper function to retrieve from cache with better error handling
async function getFromCache(key) {
    if (!redisClient.isReady) return null;
    
    try {
        const data = await redisClient.get(key);
        return data ? JSON.parse(data) : null; // Handle null/undefined value
    } catch (err) {
        console.warn(`Cache retrieval failed for key ${key}:`, err.message);
        return null;
    }
}

// Helper function to calculate standard deviation
function calculateStandardDeviation(values) {
    if (!values || values.length === 0) return 0;
    
    const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squareDiffs = values.map(value => Math.pow(value - avg, 2));
    const avgSquareDiff = squareDiffs.reduce((sum, val) => sum + val, 0) / squareDiffs.length;
    return Math.sqrt(avgSquareDiff);
}

// Check if a trend is stable
function isStable(values) {
    if (!values || values.length <= 2) return true;
    
    // Filter out null values
    const validValues = values.filter(val => val !== null && val !== undefined);
    if (validValues.length <= 2) return true;
    
    // Calculate percentage changes
    const changes = [];
    for (let i = 1; i < validValues.length; i++) {
        if (validValues[i-1] === 0) continue;
        changes.push(Math.abs((validValues[i] - validValues[i-1]) / validValues[i-1]));
    }
    
    // If average change is less than 15%, consider stable
    return changes.length === 0 || 
           changes.reduce((sum, val) => sum + val, 0) / changes.length < 0.15;
}

// Unified and improved confidence calculation
function calculateConfidence(probabilities, yearsData) {
    if (!probabilities || probabilities.length === 0) return "none";
    if (probabilities.length === 1) return "low";
    
    // Filter out invalid values
    const validProbs = probabilities.filter(p => !isNaN(p) && p !== null);
    if (validProbs.length === 0) return "none";
    if (validProbs.length === 1) return "low";
    
    // Calculate standard deviation for consistency check
    const stdDev = calculateStandardDeviation(validProbs);
    
    // Check trend stability in closing ranks
    const closingRanks = yearsData.map(d => d.closeRank).filter(rank => rank !== null && !isNaN(rank));
    const isClosingRankStable = isStable(closingRanks);
    
    if (validProbs.length >= 4 && stdDev < 0.15 && isClosingRankStable) {
        return "very high";
    } else if (validProbs.length >= 4 && stdDev < 0.25) {
        return "high";
    } else if (validProbs.length >= 3 && stdDev < 0.2) {
        return "medium";
    } else if (validProbs.length >= 2) {
        return "low";
    }
    
    // Only one data point - check recency
    if (yearsData && yearsData.length > 0 && 
        yearsData[0].year >= new Date().getFullYear() - 2) {
        return "low";
    }
    
    return "very low";
}

// Unified recommendation message generator
function getRecommendationMessage(probability, confidence) {
    // Handle low confidence cases first
    if (confidence === "none" || confidence === "very low") {
        return "Limited historical data available. Consider this as a rough estimate.";
    }
    
    // Provide graduated recommendations based on probability
    if (probability >= 0.9) {
        return "You have an excellent chance of getting this seat based on historical data.";
    } else if (probability >= 0.75) {
        return "You have a very good chance of getting this seat based on historical data.";
    } else if (probability >= 0.6) {
        return "You have a good chance of getting this seat based on historical data.";
    } else if (probability >= 0.45) {
        return "You have a reasonable chance of getting this seat, but consider backup options.";
    } else if (probability >= 0.3) {
        return "Your chances are moderate. Consider this as a competitive option with safer backups.";
    } else if (probability >= 0.15) {
        return "Your chances are somewhat low. Consider this as a stretch option and have safer backups.";
    } else if (probability >= 0.05) {
        return "Your chances are quite low based on historical data. Consider other options.";
    } else {
        return "Historical data suggests very low probability. Consider exploring other programs or institutes.";
    }
}

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

    // Validate user rank - strict pattern match for digits only
    if (userRank && !/^\d+$/.test(userRank)) {
        return res.status(400).json({
            success: false,
            message: "User rank must be a valid integer number"
        });
    }
    
    // Now safe to convert to integer
    const userRankInt = userRank ? parseInt(userRank, 10) : 0;
    const cacheKey = `filter:${JSON.stringify(req.body)}`;

    try {
        // Check cache first
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) {
            console.log('Serving filter results from cache');
            return res.status(200).json(cachedData);
        }

        // Build parameterized query 
        let filterQuery = `
            SELECT *, ABS(NULLIF("Opening Rank", '')::INTEGER - $1) AS rank_diff
            FROM public.combined_josaa_in
            WHERE 1=1
        `;
        const params = [userRankInt];
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

        // Fixed the duplicate userRank parameter issue
        if (userRank) {
            filterQuery += ` AND NULLIF("Closing Rank", '')::INTEGER >= $1`;
            filterQuery += ` ORDER BY rank_diff DESC `;
        } else {
            filterQuery += ` ORDER BY NULLIF("Closing Rank", '')::INTEGER ASC `;
        }

        filterQuery += ` LIMIT 100`;

        const result = await pool.query(filterQuery, params);
        const responseData = {
            success: true,
            count: result.rows.length,
            message: result.rows.length === 0 ? "No matches found for the given criteria" : null,
            filterData: result.rows
        };

        // Cache the result
        await cacheResponse(cacheKey, responseData, 3600);
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
        // Check cache
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) {
            console.log('Serving suggestions from cache');
            return res.json(cachedData);
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

        // Cache the results
        await cacheResponse(cacheKey, suggestions, 1800);
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
        // Check cache
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
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
        
        // Cache the results
        await cacheResponse(cacheKey, programs, 1800);
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
        // Check cache
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }
        
        let query = `
            SELECT "Year", "Round", 
                   NULLIF("Opening Rank", '')::INTEGER AS "openRank", 
                   NULLIF("Closing Rank", '')::INTEGER AS "closeRank"
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
        
        // Cache the results
        await cacheResponse(cacheKey, responseData, 3600);
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

// Improved Probability prediction endpoint
app.post('/predict-probability', async (req, res) => {
    const { userRank, institute, program, SeatType, quota, gender } = req.body;
    
    // Validate required parameters
    if (!userRank || isNaN(Number(userRank)) || Number(userRank) <= 0) {
        return res.status(400).json({
            success: false,
            message: "Valid positive user rank is required"
        });
    }
    
    const cacheKey = `predict-probability:${JSON.stringify(req.body)}`;
    
    try {
        // Check cache first
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }
        
        // Build query with parameterized values
        const queryParams = [];
        let paramIndex = 1;
        
        let query = `
            SELECT "Year", 
                   NULLIF("Opening Rank", '')::INTEGER AS "openRank", 
                   NULLIF("Closing Rank", '')::INTEGER AS "closeRank"
            FROM public.combined_josaa_in
            WHERE 1=1
        `;
        
        // Add filters only if they have values
        const filters = [
            { field: "Institute", value: institute },
            { field: "Academic Program Name", value: program },
            { field: "Seat Type", value: SeatType },
            { field: "Quota", value: quota },
            { field: "Gender", value: gender }
        ];
        
        filters.forEach(filter => {
            if (filter.value) {
                query += ` AND "${filter.field}" = $${paramIndex}`;
                queryParams.push(filter.value);
                paramIndex++;
            }
        });
        
        // Get last 5 years of data for better statistical significance
        query += ` ORDER BY "Year" DESC LIMIT 5`;
        
        const result = await pool.query(query, queryParams);
        
        if (result.rows.length === 0) {
            const responseData = {
                success: true,
                message: "No historical data found for probability estimation",
                probability: 0,
                confidence: "none",
                historicalData: []
            };
            
            await cacheResponse(cacheKey, responseData, 86400);
            return res.status(200).json(responseData);
        }
        
        // Enhanced probability calculation
        const rankNum = Number(userRank);
        const probabilities = [];
        const yearsData = [];
        const currentYear = new Date().getFullYear();
        
        result.rows.forEach(row => {
            const openRank = Number(row.openRank);
            const closeRank = Number(row.closeRank);
            let rowProbability = 0;
            
            if (!isNaN(openRank) && !isNaN(closeRank) && openRank > 0 && closeRank > 0) {
                const diff = rankNum - closeRank;
                if (diff <= 0) {
                    // If user rank is better than or exactly equal to closing rank,
                    // assign full probability for better ranks, or 0.99 for an exact match.
                    rowProbability = rankNum === closeRank ? 0.99 : 1;
                } else if (diff <= 40) {
                    // For differences from 1 to 40, interpolate linearly between 0.98 and 0.70.
                    const maxProb = 0.98; // probability when diff is 1
                    const minProb = 0.70; // probability when diff is 40
                    rowProbability = +(maxProb - (maxProb - minProb) * ((diff - 1) / (40 - 1))).toFixed(3);
                } else if (diff <= 50) {
                    // For differences from 41 to 50, interpolate linearly between 0.69 and 0.50.
                    const maxProb = 0.69; // probability when diff is 41
                    const minProb = 0.50; // probability when diff is 50
                    rowProbability = +(maxProb - (maxProb - minProb) * ((diff - 41) / (50 - 41))).toFixed(3);
                } else if (diff <= 60) {
                    // For differences from 51 to 60, interpolate linearly between 0.49 and 0.30.
                    const maxProb = 0.49; // probability when diff is 51
                    const minProb = 0.30; // probability when diff is 60
                    rowProbability = +(maxProb - (maxProb - minProb) * ((diff - 51) / (60 - 51))).toFixed(3);
                } else if (diff <= 70) {
                    // For differences from 61 to 70, interpolate linearly between 0.29 and 0.15.
                    const maxProb = 0.29; // probability when diff is 61
                    const minProb = 0.15; // probability when diff is 70
                    rowProbability = +(maxProb - (maxProb - minProb) * ((diff - 61) / (70 - 61))).toFixed(3);
                } else if (diff <= 80) {
                    // For differences from 71 to 80, interpolate linearly between 0.14 and 0.10.
                    const maxProb = 0.14; // probability when diff is 71
                    const minProb = 0.10; // probability when diff is 80
                    rowProbability = +(maxProb - (maxProb - minProb) * ((diff - 71) / (80 - 71))).toFixed(3);
                } else {
                    // For larger differences return the minimum probability.
                    rowProbability = 0.05;
                }
                
                // Apply recency bias - more recent years should have even more weight
                const recencyFactor = row.Year === currentYear - 1 ? 1.5 : 1;
                rowProbability *= recencyFactor;
                
                probabilities.push(rowProbability);
                yearsData.push({
                    year: row.Year,
                    openRank,
                    closeRank,
                    probability: Math.min(rowProbability, 0.99) // Cap at 0.99
                });
            }
        });
        
        // Calculate final probability with enhanced weighted average
        let finalProbability = 0;
        let weightSum = 0;
        
        if (probabilities.length > 0) {
            probabilities.forEach((prob, index) => {
                // Exponential weighting for recent years
                const weight = Math.pow(1.5, probabilities.length - index - 1);
                finalProbability += prob * weight;
                weightSum += weight;
            });
            
            finalProbability = weightSum > 0 ? finalProbability / weightSum : 0;
            
            // Add pessimistic correction for borderline cases
            // If the rank is close to the most recent year's closing rank
            if (yearsData.length > 0) {
                const mostRecentYear = yearsData[0];
                if (rankNum > mostRecentYear.closeRank * 0.95 && mostRecentYear.closeRank > 0) {
                    // Apply correction factor for ranks near the threshold
                    const correction = Math.min(1, (rankNum - mostRecentYear.closeRank * 0.95) / 
                                               (mostRecentYear.closeRank * 0.05));
                    finalProbability *= (1 - correction * 0.3);
                }
            }
        }
        
        // Calculate confidence level based on data availability and consistency
        const confidence = calculateConfidence(probabilities, yearsData);
        
        const responseData = {
            success: true,
            probability: Math.min(Math.round(finalProbability * 100) / 100, 0.99),
            confidence,
            historicalData: yearsData,
            message: getRecommendationMessage(finalProbability, confidence)
        };
        
        await cacheResponse(cacheKey, responseData, 86400);
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
        // Check cache
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }
        
        // Use Promise.all for parallel queries to improve performance
        const [yearsResult, quotasResult, seatTypesResult, gendersResult, roundsResult] = await Promise.all([
            pool.query('SELECT DISTINCT "Year" FROM public.combined_josaa_in ORDER BY "Year" DESC'),
            pool.query('SELECT DISTINCT "Quota" FROM public.combined_josaa_in ORDER BY "Quota" ASC'),
            pool.query('SELECT DISTINCT "Seat Type" FROM public.combined_josaa_in ORDER BY "Seat Type" ASC'),
            pool.query('SELECT DISTINCT "Gender" FROM public.combined_josaa_in ORDER BY "Gender" ASC'),
            pool.query('SELECT DISTINCT "Round" FROM public.combined_josaa_in ORDER BY "Round" ASC')
        ]);
        
        const options = {
            years: yearsResult.rows.map(row => row.Year),
            quotas: quotasResult.rows.map(row => row.Quota),
            seatTypes: seatTypesResult.rows.map(row => row["Seat Type"]),
            genders: gendersResult.rows.map(row => row.Gender),
            rounds: roundsResult.rows.map(row => row.Round)
        };
        
        // Cache results for longer (24 hours) since this data rarely changes
        await cacheResponse(cacheKey, options, 86400);
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

// Add graceful shutdown handlers
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
    console.log('Shutting down gracefully...');
    
    try {
        // Close Redis connection
        if (redisClient.isReady) {
            await redisClient.quit();
            console.log('Redis connection closed');
        }
        
        // Close database pool
        await pool.end();
        console.log('Database connection pool closed');
        
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
}

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
