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

// --- Redis Initialization ---
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

// --- PostgreSQL Initialization ---
const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.DB_PORT,
    ssl: true, // Keep SSL enabled as in original code
});

// --- Caching Helper Functions ---
async function cacheResponse(key, data, expirationSeconds = 3600) {
    if (!redisClient.isReady) return;
    try {
        await redisClient.set(key, JSON.stringify(data), { EX: expirationSeconds });
    } catch (err) {
        console.warn(`Cache storage failed for key ${key}:`, err.message);
    }
}

async function getFromCache(key) {
    if (!redisClient.isReady) return null;
    try {
        const data = await redisClient.get(key);
        return data ? JSON.parse(data) : null;
    } catch (err) {
        console.warn(`Cache retrieval failed for key ${key}:`, err.message);
        return null;
    }
}

// --- Probability & Analysis Helper Functions ---

function calculateStandardDeviation(values) {
    if (!values || values.length === 0) return 0;
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
    return Math.sqrt(variance);
}

function isStable(values) {
    if (!values || values.length <= 2) return true; // Need at least 3 points for trend stability
    const changes = [];
    for (let i = 1; i < values.length; i++) {
        if (values[i - 1] === 0) continue; // Avoid division by zero
        changes.push(Math.abs((values[i] - values[i - 1]) / values[i - 1]));
    }
    if (changes.length === 0) return true; // Handle cases where changes couldn't be calculated
    const avgChange = changes.reduce((sum, val) => sum + val, 0) / changes.length;
    return avgChange < 0.15; // Consider stable if average percentage change is less than 15%
}

function calculateConfidence(probabilities, yearsData) {
    const n = probabilities.length;
    if (n === 0) return "none";
    if (n === 1) return "very low"; // Changed from "low" to "very low" for single data point

    const stdDev = calculateStandardDeviation(probabilities);
    const closingRanks = yearsData.map(d => d.closeRank).filter(rank => rank != null); // Ensure ranks are valid numbers
    const isClosingRankStable = isStable(closingRanks);

    // Refined confidence logic
    if (n >= 4 && stdDev < 0.15 && isClosingRankStable) return "very high";
    if (n >= 4 && stdDev < 0.25) return "high";
    if (n >= 3 && stdDev < 0.20 && isClosingRankStable) return "high"; // Added stable check
    if (n >= 3 && stdDev < 0.30) return "medium";
    if (n >= 2 && stdDev < 0.25) return "medium"; // Adjusted threshold
    return "low"; // Default for 2+ points if not meeting higher criteria
}

// Simplified single-year probability based on rank difference
function calculateSingleYearProbability(userRank, closeRank) {
    if (userRank <= closeRank) return 0.99; // High chance if rank is within closing rank

    const diff = userRank - closeRank;

    if (diff <= 40) return +(0.98 - (0.98 - 0.70) * (diff / 40)).toFixed(3);        // 98% -> 70%
    if (diff <= 80) return +(0.69 - (0.69 - 0.50) * ((diff - 40) / 40)).toFixed(3); // 69% -> 50%
    if (diff <= 120) return +(0.49 - (0.49 - 0.30) * ((diff - 80) / 40)).toFixed(3); // 49% -> 30%
    if (diff <= 200) return +(0.29 - (0.29 - 0.15) * ((diff - 120) / 80)).toFixed(3); // 29% -> 15%
    return 0.05; // Low chance if significantly above
}

// Calculates final probability, confidence, message from historical data
function calculatePredictionDetails(userRank, historicalData) {
    if (!historicalData || historicalData.length === 0) {
        return {
            probability: 0,
            confidence: "none",
            message: "No historical data available for probability estimation.",
            historicalDataForDisplay: []
        };
    }

    const rankNum = Number(userRank);
    const probabilities = [];
    const yearsData = [];
    const currentYear = new Date().getFullYear();

    // Sort historical data by year descending to easily apply recency weighting
    historicalData.sort((a, b) => b.Year - a.Year);

    historicalData.forEach(row => {
        const openRank = Number(row["Opening Rank"]);
        const closeRank = Number(row["Closing Rank"]);

        // Ensure ranks are valid numbers before proceeding
        if (!isNaN(rankNum) && !isNaN(closeRank) && closeRank > 0) {
            let rowProbability = calculateSingleYearProbability(rankNum, closeRank);

            // Apply simple recency bias (can be adjusted)
            const yearDiff = currentYear - row.Year;
            const recencyFactor = Math.max(0.5, 1 - yearDiff * 0.1); // Less penalty for older years than before
            rowProbability *= recencyFactor;
            rowProbability = Math.min(rowProbability, 0.99); // Cap probability

            probabilities.push(rowProbability);
            yearsData.push({
                year: row.Year,
                openRank: isNaN(openRank) ? null : openRank, // Handle potential NaN for display
                closeRank: closeRank,
                // probability: rowProbability // Don't necessarily need to store this intermediate step
            });
        } else {
             // Include year even if ranks are missing/invalid for historical context
             yearsData.push({
                year: row.Year,
                openRank: isNaN(openRank) ? null : openRank,
                closeRank: isNaN(closeRank) ? null : closeRank,
            });
        }
    });

    let finalProbability = 0;
    let weightSum = 0;

    if (probabilities.length > 0) {
        // Weighted average - giving more importance to recent years (exponential weighting)
        probabilities.forEach((prob, index) => {
            const weight = Math.pow(1.5, probabilities.length - index - 1); // More recent years (lower index after sort) get higher weight
            finalProbability += prob * weight;
            weightSum += weight;
        });
        finalProbability = finalProbability / weightSum;
        finalProbability = Math.min(Math.max(finalProbability, 0), 0.99); // Ensure bounds 0 to 0.99
    }

    const confidence = calculateConfidence(probabilities, yearsData); // Pass raw probabilities and year data
    const message = getRecommendationMessage(finalProbability, confidence);

    return {
        probability: +(finalProbability.toFixed(2)), // Round to 2 decimal places
        confidence,
        message,
        historicalDataForDisplay: yearsData // Return structured data for potential display
    };
}


function getRecommendationMessage(probability, confidence) {
    if (confidence === "none" || confidence === "very low") {
        return "Limited historical data. Probability estimate is unreliable.";
    }
    if (confidence === "low") {
         // Add a note about low confidence
         const baseMessage = getBaseRecommendation(probability);
         return `${baseMessage} (Confidence in this prediction is low due to limited or inconsistent data.)`;
    }

    // Recommendations for medium, high, very high confidence
    return getBaseRecommendation(probability);
}

// Base recommendation text without confidence modifier
function getBaseRecommendation(probability) {
    if (probability >= 0.9) return "Excellent chance based on historical trends.";
    if (probability >= 0.75) return "Very good chance based on historical trends.";
    if (probability >= 0.6) return "Good chance based on historical trends.";
    if (probability >= 0.45) return "Reasonable chance, but consider backup options.";
    if (probability >= 0.3) return "Moderate chance. Treat as competitive; have safer backups.";
    if (probability >= 0.15) return "Chance is somewhat low. Treat as a reach; focus on safer backups.";
    if (probability >= 0.05) return "Chance is quite low. Prioritize other options.";
    return "Very low probability based on historical data. Explore other options.";
}

// --- Endpoints ---

// Health check endpoint (Unchanged)
app.get('/health', async (req, res) => {
    try {
        const dbResult = await pool.query('SELECT NOW()');
        res.status(200).json({
            success: true,
            database: "connected",
            redis: redisClient.isReady ? "connected" : "disconnected",
            timestamp: dbResult.rows[0].now
        });
    } catch (error) {
        console.error("Health check error:", error);
        res.status(500).json({
            success: false,
            database: "disconnected",
            redis: redisClient.isReady ? "connected" : "disconnected",
            error: error.message
        });
    }
});

// *** Unified Filter & Probability Endpoint ***
app.post('/filter', async (req, res) => {
    const {
        institute,
        AcademicProgramName,
        quota,
        SeatType,
        gender,
        userRank, // Keep userRank optional for basic filtering
        Year,
        round
    } = req.body;

    // Validate userRank if provided
    let userRankInt = null;
    if (userRank !== undefined && userRank !== null && userRank !== '') {
        if (!/^\d+$/.test(userRank) || parseInt(userRank, 10) <= 0) {
            return res.status(400).json({
                success: false,
                message: "User rank must be a positive integer number."
            });
        }
        userRankInt = parseInt(userRank, 10);
    }

    // Use a more robust cache key, including whether userRank was provided
    const cacheKey = `filter:v2:${JSON.stringify({...req.body, userRankProvided: !!userRankInt})}`;

    try {
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) {
            console.log('Serving filter results from cache');
            return res.status(200).json(cachedData);
        }

        // --- Step 1: Initial Filtering Query ---
        // Find potential matches based on filters. If userRank is given,
        // we can pre-filter slightly, but the main probability calc happens later.
        let filterQuery = `
            SELECT
                "Institute",
                "Academic Program Name",
                "Quota",
                "Seat Type",
                "Gender",
                "Year",
                "Round",
                NULLIF("Opening Rank", '')::INTEGER AS "Opening Rank",
                NULLIF("Closing Rank", '')::INTEGER AS "Closing Rank"
                ${userRankInt ? `, ABS(NULLIF("Closing Rank", '')::INTEGER - $1) AS rank_diff` : ''}
            FROM public.combined_josaa_in
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (userRankInt) {
            params.push(userRankInt);
            paramIndex++;
        }

        // Add filters dynamically
        const filters = [
            { column: "Institute", value: institute, isLike: true },
            { column: "Academic Program Name", value: AcademicProgramName, isLike: true },
            { column: "Quota", value: quota },
            { column: "Seat Type", value: SeatType },
            { column: "Gender", value: gender },
            { column: "Year", value: Year },
            { column: "Round", value: round },
        ];

        filters.forEach(f => {
            if (f.value) {
                if (f.isLike) {
                    filterQuery += ` AND "${f.column}" ILIKE $${paramIndex}`;
                    params.push(`%${f.value}%`);
                } else {
                    filterQuery += ` AND "${f.column}" = $${paramIndex}`;
                    params.push(f.value);
                }
                paramIndex++;
            }
        });

        // --- Ordering ---
        // If userRank is provided, order by closeness to the user's rank (within a reasonable threshold perhaps)
        // If not, order by closing rank ascending or another default.
        // We only fetch the *latest* round/year matching criteria here for the *initial* list.
        // We will fetch full history later for probability calculation.
        if (userRankInt) {
             // Prioritize results where closing rank is somewhat close to user rank
            filterQuery += ` AND NULLIF("Closing Rank", '')::INTEGER >= $1 - 500`; // Example: Look up to 500 ranks below user rank
             filterQuery += ` ORDER BY "Year" DESC, "Round" DESC, rank_diff ASC`;
        } else {
            filterQuery += ` ORDER BY "Year" DESC, "Round" DESC, "Institute" ASC, "Academic Program Name" ASC, NULLIF("Closing Rank", '')::INTEGER ASC`;
        }

        // Limit initial results to avoid overwhelming processing
        filterQuery += ` LIMIT 150`; // Adjust limit as needed

        const initialResult = await pool.query(filterQuery, params);
        let filteredData = initialResult.rows;

        // --- Step 2: Fetch Historical Data & Calculate Probability (if userRank provided) ---
        if (userRankInt && filteredData.length > 0) {
            // Create unique keys for each program combination found
            const uniqueProgramKeys = new Set();
            const programMap = new Map(); // To easily map results back

            filteredData.forEach(row => {
                const key = `${row.Institute}|${row["Academic Program Name"]}|${row.Quota}|${row["Seat Type"]}|${row.Gender}`;
                uniqueProgramKeys.add(key);
                if (!programMap.has(key)) {
                    programMap.set(key, { // Store base info for historical query
                        Institute: row.Institute,
                        "Academic Program Name": row["Academic Program Name"],
                        Quota: row.Quota,
                        "Seat Type": row["Seat Type"],
                        Gender: row.Gender
                    });
                }
            });

            // Build a query to get all historical data for these specific combinations
            let historicalQuery = `
                SELECT
                    "Institute", "Academic Program Name", "Quota", "Seat Type", "Gender",
                    "Year", "Round",
                    NULLIF("Opening Rank", '')::INTEGER AS "Opening Rank",
                    NULLIF("Closing Rank", '')::INTEGER AS "Closing Rank"
                FROM public.combined_josaa_in
                WHERE ( "Institute", "Academic Program Name", "Quota", "Seat Type", "Gender" )
                IN ( VALUES ${Array.from(programMap.keys()).map((_, i) => `($${i*5+1}, $${i*5+2}, $${i*5+3}, $${i*5+4}, $${i*5+5})`).join(', ')} )
                ORDER BY "Institute", "Academic Program Name", "Quota", "Seat Type", "Gender", "Year" DESC, "Round" DESC;
            `;
            const historicalParams = Array.from(programMap.values()).flatMap(p => [
                p.Institute, p["Academic Program Name"], p.Quota, p["Seat Type"], p.Gender
            ]);

            const historicalResult = await pool.query(historicalQuery, historicalParams);

            // Group historical data by the unique program key
            const historicalDataGrouped = {};
            historicalResult.rows.forEach(row => {
                const key = `${row.Institute}|${row["Academic Program Name"]}|${row.Quota}|${row["Seat Type"]}|${row.Gender}`;
                if (!historicalDataGrouped[key]) {
                    historicalDataGrouped[key] = [];
                }
                // Keep only the last round's data for each year for simplicity in probability trend
                 if (!historicalDataGrouped[key].some(existing => existing.Year === row.Year)) {
                    historicalDataGrouped[key].push(row);
                 }
            });

            // --- Step 3: Augment Filtered Data with Probability ---
            filteredData = filteredData.map(row => {
                const key = `${row.Institute}|${row["Academic Program Name"]}|${row.Quota}|${row["Seat Type"]}|${row.Gender}`;
                const history = historicalDataGrouped[key] || [];
                const predictionDetails = calculatePredictionDetails(userRankInt, history);

                return {
                    ...row, // Keep original filter result data
                    probability: predictionDetails.probability,
                    confidence: predictionDetails.confidence,
                    recommendation: predictionDetails.message,
                    // Optionally include historical data used for calculation if needed by frontend
                    // historicalData: predictionDetails.historicalDataForDisplay
                };
            });

             // Re-sort based on probability AND rank difference if desired
             filteredData.sort((a, b) => {
                 // Prioritize higher probability
                 if (b.probability !== a.probability) {
                     return b.probability - a.probability;
                 }
                 // Then prioritize closer rank difference
                 return a.rank_diff - b.rank_diff;
             });

             // Optional: Filter out very low probability results if the list is long
             // filteredData = filteredData.filter(row => row.probability >= 0.05);

        } // End of probability calculation block

        const responseData = {
            success: true,
            count: filteredData.length,
            message: filteredData.length === 0 ? "No matches found for the given criteria." : (userRankInt ? "Filtered results with probability estimation." : "Filtered results."),
            filterData: filteredData
        };

        await cacheResponse(cacheKey, responseData, userRankInt ? 1800 : 3600); // Shorter cache for probability results?
        res.status(200).json(responseData);

    } catch (error) {
        console.error("Filter endpoint error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching or processing filter data.",
            error: error.message
        });
    }
});


// Suggestion endpoints (Unchanged, but ensure caching keys are distinct)
app.get('/suggest-institutes', async (req, res) => {
    const { term } = req.query;
    if (!term || term.trim() === '') {
        return res.status(400).json({ success: false, message: "Search term required" });
    }
    const cacheKey = `suggest-institutes:${term.toLowerCase()}`; // Normalize cache key

    try {
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) return res.json(cachedData);

        const query = `
            SELECT DISTINCT "Institute"
            FROM public.combined_josaa_in
            WHERE "Institute" ILIKE $1
            ORDER BY "Institute" ASC
            LIMIT 10;
        `;
        const result = await pool.query(query, [`%${term}%`]);
        const suggestions = result.rows.map(r => r.Institute);

        await cacheResponse(cacheKey, suggestions, 1800); // Cache for 30 mins
        res.json(suggestions);
    } catch (error) {
        console.error("Institute suggestion error:", error);
        res.status(500).json({ success: false, message: "Error fetching suggestions", error: error.message });
    }
});

app.get('/suggest-programs', async (req, res) => {
    const { term } = req.query;
     if (!term || term.trim() === '') {
         return res.status(400).json({ success: false, message: "Search term required" });
     }
    const cacheKey = `suggest-programs:${term.toLowerCase()}`; // Normalize cache key

    try {
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) return res.json(cachedData);

        const query = `
            SELECT DISTINCT "Academic Program Name" as program
            FROM public.combined_josaa_in
            WHERE "Academic Program Name" ILIKE $1
            ORDER BY "Academic Program Name" ASC
            LIMIT 10;
        `;
        const result = await pool.query(query, [`%${term}%`]);
        const programs = result.rows.map(r => r.program);

        await cacheResponse(cacheKey, programs, 1800); // Cache for 30 mins
        res.json(programs);
    } catch (error) {
        console.error("Program suggestion error:", error);
        res.status(500).json({ success: false, message: "Error fetching program suggestions", error: error.message });
    }
});


// Rank trends endpoint (Remains useful for detailed historical charts)
app.post('/rank-trends', async (req, res) => {
    const { institute, program, SeatType, quota, gender } = req.body;

    if (!institute || !program || !SeatType || !quota || !gender) { // Require all specifics for a meaningful trend
        return res.status(400).json({
            success: false,
            message: "Please provide Institute, Program Name, Seat Type, Quota, and Gender for rank trends."
        });
    }

    const cacheKey = `rank-trends:${JSON.stringify(req.body)}`;

    try {
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) return res.status(200).json(cachedData);

        const query = `
            SELECT
                "Year", "Round",
                NULLIF("Opening Rank", '')::INTEGER AS "Opening Rank",
                NULLIF("Closing Rank", '')::INTEGER AS "Closing Rank"
            FROM public.combined_josaa_in
            WHERE "Institute" = $1
              AND "Academic Program Name" = $2
              AND "Seat Type" = $3
              AND "Quota" = $4
              AND "Gender" = $5
            ORDER BY "Year" ASC, "Round" ASC;
        `;
        const params = [institute, program, SeatType, quota, gender];
        const result = await pool.query(query, params);

        const finalData = result.rows.sort((a, b) => a.Year - b.Year);


        const responseData = {
            success: true,
            message: finalData.length === 0 ? "No trend data found for the specific criteria." : null,
            data: finalData // Return processed data (e.g., last round per year)
        };

        await cacheResponse(cacheKey, responseData, 3600); // Cache for 1 hour
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

// --- REMOVED /predict-probability endpoint ---

// Filter options endpoint (Unchanged)
app.get('/filter-options', async (req, res) => {
    const cacheKey = 'filter-options:v2'; // Update cache key if needed

    try {
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) return res.status(200).json(cachedData);

        const [yearsResult, quotasResult, seatTypesResult, gendersResult, roundsResult] = await Promise.all([
            pool.query('SELECT DISTINCT "Year" FROM public.combined_josaa_in ORDER BY "Year" DESC'),
            pool.query('SELECT DISTINCT "Quota" FROM public.combined_josaa_in WHERE "Quota" IS NOT NULL ORDER BY "Quota" ASC'),
            pool.query('SELECT DISTINCT "Seat Type" FROM public.combined_josaa_in WHERE "Seat Type" IS NOT NULL ORDER BY "Seat Type" ASC'),
            pool.query('SELECT DISTINCT "Gender" FROM public.combined_josaa_in WHERE "Gender" IS NOT NULL ORDER BY "Gender" ASC'),
            pool.query('SELECT DISTINCT "Round" FROM public.combined_josaa_in ORDER BY "Round" ASC')
        ]);

        const options = {
            years: yearsResult.rows.map(row => row.Year),
            quotas: quotasResult.rows.map(row => row.Quota),
            seatTypes: seatTypesResult.rows.map(row => row["Seat Type"]),
            genders: gendersResult.rows.map(row => row.Gender),
            rounds: roundsResult.rows.map(row => row.Round)
        };

        await cacheResponse(cacheKey, options, 86400); // Cache for 24 hours
        res.status(200).json(options);
    } catch (error) {
        console.error("Filter options error:", error);
        res.status(500).json({ success: false, message: "Error fetching filter options", error: error.message });
    }
});

// Global error handler (Unchanged)
app.use((err, req, res, next) => {
    console.error("Global error:", err.stack); // Log stack trace for better debugging
    res.status(500).json({
        success: false,
        message: "An unexpected server error occurred.",
        // Avoid leaking detailed error messages in production
        error: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message
    });
});

// Start server (Unchanged)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
