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
    }};
    
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
        if (redisClient.isReady) {
            try {
                const cachedData = await redisClient.get(cacheKey);
                if (cachedData) {
                    return res.status(200).json(JSON.parse(cachedData));
                }
            } catch (cacheError) {
                console.warn("Cache retrieval failed:", cacheError.message);
                // Continue execution even if cache fails
            }
        }
        
        // Build query with parameterized values
        const queryParams = [];
        let paramIndex = 1;
        
        let query = `
            SELECT "Year", 
                   NULLIF("Opening Rank", '')::INTEGER AS "Opening Rank", 
                   NULLIF("Closing Rank", '')::INTEGER AS "Closing Rank"
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
                confidence: "low",
                historicalData: []
            };
            
            cacheResponse(cacheKey, responseData);
            return res.status(200).json(responseData);
        }
        
        // Improved probability calculation
        const rankNum = Number(userRank);
        const probabilities = [];
        const yearsData = [];
        const currentYear = new Date().getFullYear();
        
        result.rows.forEach(row => {
            const openRank = Number(row["Opening Rank"]);
            const closeRank = Number(row["Closing Rank"]);
            let rowProbability = 0;
            
            if (!isNaN(openRank) && !isNaN(closeRank) && openRank > 0 && closeRank > 0) {
                if (rankNum <= closeRank) {
                    if (rankNum <= openRank) {
                        // Rank better than opening rank (high probability)
                        rowProbability = 0.99;
                    } else {
                        // Rank between opening and closing (more aggressive scaling)
                        const position = (rankNum - openRank) / (closeRank - openRank);
                        // More steep decline as you approach closing rank
                        rowProbability = 0.95 - (Math.pow(position, 0.8) * 0.75);
                    }
                } else {
                    // Rank worse than closing rank (more rapid decay)
                    const difference = rankNum - closeRank;
                    const threshold = closeRank * 0.05; // Reduced threshold for stricter cutoff
                    
                    if (difference <= threshold) {
                        // Exponential decay instead of linear
                        rowProbability = 0.15 * Math.exp(-3 * (difference / threshold));
                    } else {
                        rowProbability = 0.01; // Even lower base probability for ranks well beyond closing
                    }
                }
                
                // Apply recency bias - more recent years should have even more weight
                const recencyFactor = row["Year"] === currentYear - 1 ? 1.5 : 1;
                rowProbability *= recencyFactor;
                
                probabilities.push(rowProbability);
                yearsData.push({
                    year: row["Year"],
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
            
            finalProbability = finalProbability / weightSum;
            
            // Add pessimistic correction for borderline cases
            // If the rank is close to the most recent year's closing rank
            if (yearsData.length > 0) {
                const mostRecentYear = yearsData[0];
                if (rankNum > mostRecentYear.closeRank * 0.95) {
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
        
        cacheResponse(cacheKey, responseData);
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

// Helper function to cache response


// Helper function to calculate confidence level
function calculateConfidence(probabilities, yearsData) {
    if (probabilities.length === 0) return "low";
    
    // More data points = higher confidence
    if (probabilities.length >= 4) {
        // Check consistency in trend
        const stdDev = calculateStandardDeviation(probabilities);
        
        if (stdDev < 0.15) return "very high";
        if (stdDev < 0.25) return "high";
        return "medium";
    } else if (probabilities.length >= 2) {
        // Check consistency in recent years
        const stdDev = calculateStandardDeviation(probabilities);
        
        if (stdDev < 0.2) return "medium";
        return "low";
    }
    
    // Only one data point - check recency
    if (yearsData.length > 0 && yearsData[0].year >= new Date().getFullYear() - 2) {
        return "low";
    }
    
    return "very low";
}

// Helper function to calculate standard deviation
function calculateStandardDeviation(values) {
    const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squareDiffs = values.map(value => Math.pow(value - avg, 2));
    const avgSquareDiff = squareDiffs.reduce((sum, val) => sum + val, 0) / squareDiffs.length;
    return Math.sqrt(avgSquareDiff);
}

// Helper function to generate recommendation message
function getRecommendationMessage(probability, confidence) {
    if (probability >= 0.9) {
        return "You have an excellent chance of getting this seat based on historical data.";
    } else if (probability >= 0.7) {
        return "You have a good chance of getting this seat based on historical data.";
    } else if (probability >= 0.5) {
        return "You have a reasonable chance of getting this seat, but consider backup options.";
    } else if (probability >= 0.3) {
        return "Your chances are somewhat low. Consider this as a stretch option and have safer backups.";
    } else if (probability >= 0.1) {
        return "Your chances are quite low based on historical data. Consider other options.";
    } else {
        return "Historical data suggests very low probability. Consider exploring other programs or institutes.";
    }
}

// Helper function to cache response
function cacheResponse(key, data) {
    if (redisClient.isReady) {
        try {
            redisClient.set(key, JSON.stringify(data), { EX: 3600 })
                .catch(err => console.warn("Cache storage failed:", err.message));
        } catch (err) {
            console.warn("Cache attempt failed:", err.message);
        }
    }
}

// Calculate confidence level based on data consistency
function calculateConfidence(probabilities, yearsData) {
    if (probabilities.length === 0) return "none";
    if (probabilities.length === 1) return "low";
    
    // Check for consistency in data
    const variance = calculateVariance(probabilities);
    
    // Check trend stability
    const isClosingRankStable = isStable(yearsData.map(d => d.closeRank));
    
    if (probabilities.length >= 4 && variance < 0.05 && isClosingRankStable) {
        return "high";
    } else if (probabilities.length >= 3 && variance < 0.1) {
        return "medium";
    } else {
        return "low";
    }
}

// Calculate statistical variance
function calculateVariance(values) {
    if (values.length <= 1) return 0;
    
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    return squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length;
}

// Check if a trend is stable
function isStable(values) {
    if (values.length <= 2) return true;
    
    // Calculate percentage changes
    const changes = [];
    for (let i = 1; i < values.length; i++) {
        if (values[i-1] === 0) continue;
        changes.push(Math.abs((values[i] - values[i-1]) / values[i-1]));
    }
    
    // If average change is less than 15%, consider stable
    return changes.reduce((sum, val) => sum + val, 0) / changes.length < 0.15;
}

// Get recommendation message based on probability
function getRecommendationMessage(probability, confidence) {
    if (confidence === "none" || confidence === "low") {
        return "Limited historical data available. Consider this as a rough estimate.";
    }
    
    if (probability >= 0.85) {
        return "High probability of admission. This choice appears to be safe based on historical trends.";
    } else if (probability >= 0.60) {
        return "Good probability of admission. This appears to be a reasonable choice based on historical data.";
    } else if (probability >= 0.30) {
        return "Moderate probability. Consider this as a competitive option.";
    } else {
        return "Low probability based on historical data. Consider this as an ambitious choice.";
    }
}
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
