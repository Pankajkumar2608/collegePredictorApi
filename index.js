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
    ssl: true, 
});

// --- Caching Helper Functions ---
async function cacheResponse(key, data, expirationSeconds = 3600) {
    if (!redisClient.isReady) {
        console.warn(`Redis not ready. Cache storage failed for key ${key}`);
        return;
    }
    try {
        await redisClient.set(key, JSON.stringify(data), { EX: expirationSeconds });
    } catch (err) {
        console.warn(`Cache storage failed for key ${key}:`, err.message);
    }
}

async function getFromCache(key) {
    if (!redisClient.isReady) {
        console.warn(`Redis not ready. Cache retrieval failed for key ${key}`);
        return null;
    }
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

/**
 * Calculates probability of admission based on user's rank and a target closing rank.
 * @param {number} userRank - The user's rank.
 * @param {number} targetRank - The target closing rank (e.g., projected closing rank).
 * @returns {number} Probability between 0.01 and 0.99.
 */
function getProbabilityAgainstTarget(userRank, targetRank) {
    userRank = Number(userRank);
    targetRank = Number(targetRank);

    if (isNaN(userRank) || isNaN(targetRank) || targetRank <= 0) return 0.01;

    // If user's rank is better than or equal to the target closing rank, high probability.
    if (userRank <= targetRank) {
        return 0.98; // High fixed probability
    }

    // If user's rank is worse than the target closing rank.
    const diff = userRank - targetRank; // Positive difference
    
    // k_factor determines how quickly probability drops. Smaller k_factor -> faster drop.
    // Larger targetRanks should have a larger k (more buffer).
    const k_factor = 0.25; 
    const k = Math.max(500, targetRank * k_factor); // k is influenced by targetRank, min 500.

    // Exponential decay for probability. Max probability here is 0.90.
    let probability = 0.90 * Math.exp(-diff / k); 

    // Clamp probability between 0.01 and 0.90 for this case.
    probability = Math.max(0.01, Math.min(probability, 0.90));
    return +probability.toFixed(3); // Return as number with 3 decimal places
}


/**
 * Calculates prediction details including projected rank, probability, and confidence.
 * @param {number} userRankInput - The user's rank.
 * @param {Array} historicalCutoffs - Array of { year, closeRank, round } for the latest round of each historical year.
 * @returns {object} Prediction details.
 */
function calculatePredictionDetails(userRankInput, historicalCutoffs) {
    if (!historicalCutoffs || historicalCutoffs.length === 0) {
        return {
            projectedRank: null,
            probability: 0,
            confidence: "none",
            message: "No historical data for projection.",
            recommendation: getBaseRecommendation(0),
            historicalDataForDisplay: [] 
        };
    }

    const userRank = Number(userRankInput);

    historicalCutoffs.sort((a, b) => b.year - a.year); // Most recent first

    let weightedRankSum = 0;
    let totalWeight = 0;
    const recencyWeights = [1.0, 0.85, 0.7, 0.55, 0.4]; 

    historicalCutoffs.slice(0, recencyWeights.length).forEach((data, index) => {
        if (data.closeRank !== null && !isNaN(data.closeRank)) {
            const weight = recencyWeights[index] || 0.3; 
            weightedRankSum += data.closeRank * weight;
            totalWeight += weight;
        }
    });

    if (totalWeight === 0) { 
        return {
            projectedRank: null,
            probability: 0,
            confidence: "very low",
            message: "Insufficient valid historical data for projection.",
            recommendation: getBaseRecommendation(0),
            historicalDataForDisplay: historicalCutoffs.map(h => ({...h})) 
        };
    }
    let projectedClosingRank = weightedRankSum / totalWeight;

    if (historicalCutoffs.length >= 2) {
        const latest = historicalCutoffs[0]; 
        const previous = historicalCutoffs[1]; 
        if (latest.closeRank !== null && previous.closeRank !== null && previous.closeRank > 0) {
            const change = latest.closeRank - previous.closeRank; 
            const relativeChange = change / previous.closeRank;
            const maxAdjustmentRatio = 0.10; 
            if (Math.abs(relativeChange) > 0.03) { 
                 let adjustment = 0;
                 if (change < 0) { 
                    adjustment = projectedClosingRank * Math.max(-maxAdjustmentRatio, relativeChange * 0.5); 
                 } else if (change > 0) { 
                    adjustment = projectedClosingRank * Math.min(maxAdjustmentRatio, relativeChange * 0.5); 
                 }
                 projectedClosingRank += adjustment;
            }
        }
    }
    projectedClosingRank = Math.max(1, Math.round(projectedClosingRank)); 
    const finalProbability = getProbabilityAgainstTarget(userRank, projectedClosingRank);
    const historicalRanksForConfidence = historicalCutoffs.map(h => h.closeRank).filter(r => r !== null && !isNaN(r));
    const stdDevHistRanks = calculateStandardDeviation(historicalRanksForConfidence);
    const relativeStdDev = historicalRanksForConfidence.length > 0 && projectedClosingRank > 0 ?
                           stdDevHistRanks / projectedClosingRank : 1; 

    let confidence = "low";
    const nPoints = historicalRanksForConfidence.length;

    if (nPoints >= 4) {
        if (relativeStdDev < 0.10) confidence = "very high";
        else if (relativeStdDev < 0.15) confidence = "high";
        else if (relativeStdDev < 0.25) confidence = "medium";
        else confidence = "low";
    } else if (nPoints === 3) {
        if (relativeStdDev < 0.15) confidence = "high";
        else if (relativeStdDev < 0.20) confidence = "medium";
        else confidence = "low";
    } else if (nPoints === 2) {
        if (relativeStdDev < 0.20) confidence = "medium";
        else confidence = "low";
    } else { 
        confidence = "very low";
    }

    const message = getRecommendationMessage(finalProbability, confidence);
    const recommendation = getBaseRecommendation(finalProbability);

    return {
        projectedRank: projectedClosingRank,
        probability: +(finalProbability.toFixed(2)),
        confidence,
        message,
        recommendation,
    };
}


function getRecommendationMessage(probability, confidence) {
    const baseMessage = getBaseRecommendation(probability);
    if (confidence === "none") return "No historical data to estimate probability.";
    if (confidence === "very low") return `${baseMessage} (Prediction confidence: Very Low due to limited/inconsistent data.)`;
    if (confidence === "low") return `${baseMessage} (Prediction confidence: Low due to data limitations.)`;
    if (confidence === "medium") return `${baseMessage} (Prediction confidence: Medium.)`;
    if (confidence === "high") return `${baseMessage} (Prediction confidence: High.)`;
    if (confidence === "very high") return `${baseMessage} (Prediction confidence: Very High.)`;
    return baseMessage;
}

function getBaseRecommendation(probability) {
    if (probability >= 0.95) return "Excellent chance"; 
    if (probability >= 0.80) return "Very good chance";
    if (probability >= 0.60) return "Good chance";
    if (probability >= 0.40) return "Reasonable chance";
    if (probability >= 0.20) return "Moderate chance";
    if (probability >= 0.10) return "Low chance";
    if (probability >= 0.05) return "Very low chance";
    return "Extremely low chance";
}

function getInstituteType(value) {
    if (!value) return 'UNKNOWN';
    const valStr = String(value).trim();
    const valUpper = valStr.toUpperCase();

    if (valUpper === 'IIT') return 'IIT';
    if (valUpper === 'NIT') return 'NIT';
    if (valUpper === 'IIIT') return 'IIIT';
    if (valUpper === 'GFTI') return 'GFTI';

    const nameLower = valStr.toLowerCase();
    if (nameLower.includes('indian institute of technology') || nameLower.startsWith('iit')) return 'IIT';
    if (nameLower.includes('national institute of technology') || nameLower.includes('iiest, shibpur') || nameLower.startsWith('nit')) return 'NIT';
    if (nameLower.includes('indian institute of information technology') || nameLower.startsWith('iiit')) return 'IIIT';
    
    return 'GFTI'; 
}


// --- Endpoints ---
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

app.post('/filter', async (req, res) => {
    const {
        institute, AcademicProgramName, quota, SeatType, gender,
        userRank, Year, round, instituteType 
    } = req.body;

    let userRankInt = null;
    if (userRank !== undefined && userRank !== null && String(userRank).trim() !== '') {
        if (!/^\d+$/.test(userRank) || parseInt(userRank, 10) <= 0) {
            return res.status(400).json({ success: false, message: "User rank must be a positive integer." });
        }
        userRankInt = parseInt(userRank, 10);
    }

    let effectiveYear = (Year !== undefined && Year !== null && String(Year).trim() !== '') ? parseInt(Year, 10) : null;
    let effectiveRound = (round !== undefined && round !== null && String(round).trim() !== '') ? parseInt(round, 10) : null;

    try {
        if (effectiveYear === null) {
            const latestYearResult = await pool.query(`SELECT MAX("Year") as max_year FROM public.combined_josaa_in`);
            if (latestYearResult.rows.length > 0 && latestYearResult.rows[0].max_year !== null) {
                effectiveYear = parseInt(latestYearResult.rows[0].max_year, 10);
            }
        }
        if (effectiveRound === null && effectiveYear !== null) {
            const latestRoundResult = await pool.query(
                `SELECT MAX("Round") as max_round FROM public.combined_josaa_in WHERE "Year" = $1`, [effectiveYear]
            );
            if (latestRoundResult.rows.length > 0 && latestRoundResult.rows[0].max_round !== null) {
                effectiveRound = parseInt(latestRoundResult.rows[0].max_round, 10);
            }
        }

        const actualFiltersForCache = {
            institute, AcademicProgramName, quota, SeatType, gender,
            userRank: userRankInt, Year: effectiveYear, round: effectiveRound, instituteType
        };
        // Cache key version bump due to significant sorting logic change
        const cacheKey = `filter:v9_targeted_sort:${JSON.stringify(actualFiltersForCache)}`;

        const cachedData = await getFromCache(cacheKey);
        if (cachedData) {
            console.log('Serving filter results from cache (v9_targeted_sort) for key:', cacheKey);
            return res.status(200).json(cachedData);
        }

        let filterQuery = `
            SELECT
                "Institute", "Academic Program Name", "Quota", "Seat Type", "Gender",
                "Year", "Round", "College type", 
                NULLIF("Opening Rank", '')::INTEGER AS "Opening Rank",
                NULLIF("Closing Rank", '')::INTEGER AS "Closing Rank"
        `;
        // rank_diff is calculated based on userRankInt and Closing Rank from the selected Year/Round.
        // It's used for the initial SQL sort if userRankInt is present.
        // The more complex JS sort later will refine this.
        if (userRankInt) {
            filterQuery += `, ABS(NULLIF("Closing Rank", '')::INTEGER - $1) AS rank_diff`;
        }
        filterQuery += ` FROM public.combined_josaa_in WHERE 1=1 `;
        
        const params = [];
        let paramIndex = 1;
        if (userRankInt) { params.push(userRankInt); paramIndex++; }
        if (effectiveYear !== null) { filterQuery += ` AND "Year" = $${paramIndex++}`; params.push(effectiveYear); }
        if (effectiveRound !== null) { filterQuery += ` AND "Round" = $${paramIndex++}`; params.push(effectiveRound); }
        
        if (instituteType && String(instituteType).toLowerCase() !== 'all') {
            filterQuery += ` AND "College type" ILIKE $${paramIndex++}`;
            params.push(instituteType); 
        }
        
        const otherFiltersConfig = [
            { column: "Institute", value: institute, isLike: true },
            { column: "Academic Program Name", value: AcademicProgramName, isLike: true },
            { column: "Quota", value: quota }, { column: "Seat Type", value: SeatType }, { column: "Gender", value: gender },
        ];
        otherFiltersConfig.forEach(f => {
            if (f.value) {
                if (f.isLike) { filterQuery += ` AND "${f.column}" ILIKE $${paramIndex++}`; params.push(`%${f.value}%`); }
                else { filterQuery += ` AND "${f.column}" = $${paramIndex++}`; params.push(f.value); }
            }
        });

        if (userRankInt) {
            filterQuery += ` AND NULLIF("Closing Rank", '') IS NOT NULL AND NULLIF("Closing Rank", '')::INTEGER > 0`;
            // Initial sort by rank_diff to get relevant items, JS sort will be more sophisticated
            filterQuery += ` ORDER BY rank_diff ASC, "Year" DESC, "Round" DESC`; 
        } else {
            filterQuery += ` ORDER BY "Institute" ASC, "Academic Program Name" ASC, "Year" DESC, "Round" DESC, COALESCE(NULLIF("Closing Rank", '')::INTEGER, 9999999) ASC`;
        }
        filterQuery += ` LIMIT 750;`; 

        const initialResult = await pool.query(filterQuery, params);
        let filteredData = initialResult.rows;

        if (userRankInt && filteredData.length > 0) {
            const programMapForHistory = new Map();
            filteredData.forEach(row => { 
                const key = `${row.Institute}|${row["Academic Program Name"]}|${row.Quota}|${row["Seat Type"]}|${row.Gender}`;
                if (!programMapForHistory.has(key)) {
                    programMapForHistory.set(key, { Institute: row.Institute, "Academic Program Name": row["Academic Program Name"], Quota: row.Quota, "Seat Type": row["Seat Type"], Gender: row.Gender });
                }
            });

            if (programMapForHistory.size > 0) {
                const historicalQueryValues = Array.from(programMapForHistory.keys()).map((_, i) => `($${i*5+1}, $${i*5+2}, $${i*5+3}, $${i*5+4}, $${i*5+5})`).join(', ');
                let historicalQuery = `
                    SELECT "Institute", "Academic Program Name", "Quota", "Seat Type", "Gender",
                           "Year", "Round", NULLIF("Closing Rank", '')::INTEGER AS "Closing Rank"
                    FROM public.combined_josaa_in
                    WHERE ("Institute", "Academic Program Name", "Quota", "Seat Type", "Gender")
                    IN (VALUES ${historicalQueryValues})
                    ORDER BY "Institute", "Academic Program Name", "Quota", "Seat Type", "Gender", "Year" DESC, "Round" DESC;
                `;
                const historicalParams = Array.from(programMapForHistory.values()).flatMap(p => [p.Institute, p["Academic Program Name"], p.Quota, p["Seat Type"], p.Gender]);
                const historicalResult = await pool.query(historicalQuery, historicalParams);

                const historicalDataGrouped = {}; 
                historicalResult.rows.forEach(row => {
                    const key = `${row.Institute}|${row["Academic Program Name"]}|${row.Quota}|${row["Seat Type"]}|${row.Gender}`;
                    if (!historicalDataGrouped[key]) historicalDataGrouped[key] = [];
                    historicalDataGrouped[key].push({ year: row.Year, round: row.Round, closeRank: row["Closing Rank"] });
                });

                filteredData = filteredData.map(row => {
                    const key = `${row.Institute}|${row["Academic Program Name"]}|${row.Quota}|${row["Seat Type"]}|${row.Gender}`;
                    const fullHistoryForProgram = historicalDataGrouped[key] || [];
                    
                    const latestRoundCutoffsPerYear = [];
                    const seenYears = new Set();
                    fullHistoryForProgram.sort((a, b) => { 
                        if (b.year !== a.year) return b.year - a.year;
                        return b.round - a.round;
                    });

                    for (const histItem of fullHistoryForProgram) {
                        if (histItem.closeRank !== null && !isNaN(histItem.closeRank) && !seenYears.has(histItem.year)) {
                            latestRoundCutoffsPerYear.push(histItem);
                            seenYears.add(histItem.year);
                        }
                    }
                    
                    const predictionOutput = calculatePredictionDetails(userRankInt, latestRoundCutoffsPerYear);
                    const instituteCategory = getInstituteType(row["College type"] || row.Institute);
                    
                    return {
                        ...row, 
                        ...predictionOutput, 
                        instituteCategory,
                        historicalDataForDisplay: latestRoundCutoffsPerYear.sort((a,b) => b.year - a.year) 
                    };
                });

                // ----- START OF NEW SORTING LOGIC -----
                const typeOrder = { 'IIT': 1, 'NIT': 2, 'IIIT': 3, 'GFTI': 4, 'UNKNOWN': 5 };
                const TARGET_ANCHOR_RANK_OFFSET = 1000; // User wants to see ranks around UR - 1000
                const TARGET_ANCHOR_RANGE = 500;    // Window size around the targetAnchorRank

                filteredData.sort((a, b) => {
                    // 1. Sort by Institute Category (IIT > NIT > IIIT > GFTI)
                    const typeAOrder = typeOrder[a.instituteCategory] || typeOrder['UNKNOWN'];
                    const typeBOrder = typeOrder[b.instituteCategory] || typeOrder['UNKNOWN'];
                    if (typeAOrder !== typeBOrder) return typeAOrder - typeBOrder;

                    // Prepare common variables for comparison
                    const ur = userRankInt;
                    const crA = a["Closing Rank"] === null || isNaN(Number(a["Closing Rank"])) ? Infinity : Number(a["Closing Rank"]);
                    const crB = b["Closing Rank"] === null || isNaN(Number(b["Closing Rank"])) ? Infinity : Number(b["Closing Rank"]);
                    const projRankA = a.projectedRank !== null && !isNaN(a.projectedRank) ? a.projectedRank : crA;
                    const projRankB = b.projectedRank !== null && !isNaN(b.projectedRank) ? b.projectedRank : crB;
                    const probA = a.probability;
                    const probB = b.probability;

                    const targetAnchorRank = Math.max(1, ur - TARGET_ANCHOR_RANK_OFFSET);

                    // Categorize items for sorting priority
                    let categoryA, categoryB;

                    // Determine category for item A
                    if (crA <= ur) { // Historically, user's rank was good enough
                        if (Math.abs(crA - targetAnchorRank) <= TARGET_ANCHOR_RANGE) {
                            categoryA = 1; // Sweet spot: CR <= UR and close to targetAnchorRank
                        } else {
                            categoryA = 2; // Still CR <= UR, but outside sweet spot
                        }
                    } else { // Historically, user's rank was NOT good enough (crA > ur)
                        // ur <= projRankA means user's rank is better than or equal to projected rank (good chance)
                        if (ur <= projRankA) { 
                            categoryA = 3; // Projected good chance, despite crA > ur
                        } else {
                            categoryA = 4; // Aspirational: crA > ur and ur > projRankA (low chance)
                        }
                    }

                    // Determine category for item B (similarly)
                    if (crB <= ur) {
                        if (Math.abs(crB - targetAnchorRank) <= TARGET_ANCHOR_RANGE) {
                            categoryB = 1;
                        } else {
                            categoryB = 2;
                        }
                    } else { 
                        if (ur <= projRankB) {
                            categoryB = 3;
                        } else {
                            categoryB = 4;
                        }
                    }
                    
                    // 2. Primary sort by these categories
                    if (categoryA !== categoryB) {
                        return categoryA - categoryB; // Lower category number comes first
                    }

                    // 3. Secondary sort within the same category
                    switch (categoryA) { // Both items are in the same category here
                        case 1: // CR <= ur AND CR is very close to targetAnchorRank ("Sweet Spot")
                            // Sort by actual closeness to targetAnchorRank (closer is better)
                            const distA_target = Math.abs(crA - targetAnchorRank);
                            const distB_target = Math.abs(crB - targetAnchorRank);
                            if (distA_target !== distB_target) return distA_target - distB_target;
                            // Then by probability (higher is better)
                            if (probB !== probA) return probB - probA;
                            // Then by CR (lower/better rank is better)
                            return crA - crB;

                        case 2: // CR <= ur (but not in Category 1 - other historically achievable)
                            // Sort by probability (higher is better)
                            if (probB !== probA) return probB - probA;
                            // Then by CR (lower/better rank is better)
                            return crA - crB;

                        case 3: // CR > ur AND ur <= projRank (Projected good chance - these were the "too easy" ones previously)
                            // Sort by probability (higher is better - most will be 0.98)
                            if (probB !== probA) return probB - probA;
                            // Then by projected rank (lower/better ProjR is better, prioritize tighter fits)
                            if (projRankA !== projRankB) return projRankA - projRankB;
                            // Then by CR (lower/better CR is better)
                            return crA - crB;

                        case 4: // CR > ur AND ur > projRank (Aspirational - low chance)
                            // Sort by probability (higher is better, though all likely low to moderate)
                            if (probB !== probA) return probB - probA;
                            // Then by closeness of projected rank to user rank (closer is better)
                            const diffProjA = Math.abs(projRankA - ur);
                            const diffProjB = Math.abs(projRankB - ur);
                            if (diffProjA !== diffProjB) return diffProjA - diffProjB;
                            // Then by closeness of actual CR (from last year) to user rank
                            const diffCrA = Math.abs(crA - ur); // Equivalent to rank_diff for item A
                            const diffCrB = Math.abs(crB - ur); // Equivalent to rank_diff for item B
                            if (diffCrA !== diffCrB) return diffCrA - diffCrB;
                            // Finally by CR itself (more competitive/lower CR is better)
                            return crA - crB;
                    }
                    return 0; // Should ideally not be reached if categories cover all cases
                });
                // ----- END OF NEW SORTING LOGIC -----
            }
        } else if (filteredData.length > 0) { // No user rank, but data exists
            filteredData.forEach(row => {
                row.instituteCategory = getInstituteType(row["College type"] || row.Institute);
            });
            const typeOrder = { 'IIT': 1, 'NIT': 2, 'IIIT': 3, 'GFTI': 4, 'UNKNOWN': 5 };
            filteredData.sort((a,b) => {
                const typeAOrder = typeOrder[a.instituteCategory] || typeOrder['UNKNOWN'];
                const typeBOrder = typeOrder[b.instituteCategory] || typeOrder['UNKNOWN'];
                if (typeAOrder !== typeBOrder) return typeAOrder - typeBOrder;
                if ((a.Institute || "").localeCompare(b.Institute || "") !== 0) {
                     return (a.Institute || "").localeCompare(b.Institute || "");
                }
                return (a["Academic Program Name"] || "").localeCompare(b["Academic Program Name"] || "");
            });
        }

        const responseData = {
            success: true, count: filteredData.length,
            message: filteredData.length === 0 ? "No matches found." : (userRankInt ? "Results with prediction." : "Filtered results."),
            filterData: filteredData, appliedFilters: actualFiltersForCache
        };
        await cacheResponse(cacheKey, responseData, userRankInt ? 1800 : 3600); // Cache for 30min if rank, 1hr otherwise
        res.status(200).json(responseData);

    } catch (error) {
        console.error("Filter endpoint error:", error);
        res.status(500).json({ success: false, message: "Error processing filter data.", error: error.message });
    }
});


app.get('/suggest-institutes', async (req, res) => {
    const { term, type } = req.query;
    const cacheKey = `suggest-institutes:v3_collegetype:${term?.toLowerCase() || 'all'}:${type?.toLowerCase() || 'all'}`;

    try {
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) return res.json(cachedData);

        let query = `SELECT DISTINCT "Institute" FROM public.combined_josaa_in WHERE 1=1 `;
        const params = [];
        let paramIndex = 1;

        if (term && term.trim() !== '') {
            query += ` AND "Institute" ILIKE $${paramIndex++}`;
            params.push(`%${term}%`);
        }
        
        if (type && type.toLowerCase() !== 'all') {
            const instType = type.toLowerCase(); 
            query += ` AND "College type" ILIKE $${paramIndex++}`;
            params.push(instType); 
        }

        query += ` ORDER BY "Institute" ASC LIMIT 20;`;
        const result = await pool.query(query, params);
        const suggestions = result.rows.map(r => r.Institute);

        await cacheResponse(cacheKey, suggestions, 3600);
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
    const cacheKey = `suggest-programs:v2:${term.toLowerCase()}`;

    try {
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) return res.json(cachedData);

        const query = `
            SELECT DISTINCT "Academic Program Name" as program
            FROM public.combined_josaa_in
            WHERE "Academic Program Name" ILIKE $1
            ORDER BY "Academic Program Name" ASC
            LIMIT 15; 
        `;
        const result = await pool.query(query, [`%${term}%`]);
        const programs = result.rows.map(r => r.program);

        await cacheResponse(cacheKey, programs, 3600);
        res.json(programs);
    } catch (error) {
        console.error("Program suggestion error:", error);
        res.status(500).json({ success: false, message: "Error fetching program suggestions", error: error.message });
    }
});

app.post('/rank-trends', async (req, res) => { 
    const { institute, program, SeatType, quota, gender } = req.body;

    if (!institute || !program || !SeatType || !quota || !gender) {
        return res.status(400).json({
            success: false,
            message: "Please provide Institute, Program Name, Seat Type, Quota, and Gender for rank trends."
        });
    }
    const cacheKey = `rank-trends:v3:${JSON.stringify(req.body)}`;
    try {
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) return res.status(200).json(cachedData);

        const query = `
            SELECT "Year", "Round", NULLIF("Opening Rank", '')::INTEGER AS "Opening Rank", NULLIF("Closing Rank", '')::INTEGER AS "Closing Rank"
            FROM public.combined_josaa_in
            WHERE "Institute" = $1 AND "Academic Program Name" = $2 AND "Seat Type" = $3 AND "Quota" = $4 AND "Gender" = $5
            ORDER BY "Year" ASC, "Round" ASC;
        `;
        const params = [institute, program, SeatType, quota, gender];
        const result = await pool.query(query, params);
        
        const trendsByYear = {};
        result.rows.forEach(row => {
            if (row["Closing Rank"] !== null && !isNaN(row["Closing Rank"])){ 
                if (!trendsByYear[row.Year] || row.Round > trendsByYear[row.Year].Round) { 
                    trendsByYear[row.Year] = row;
                }
            }
        });
        const finalData = Object.values(trendsByYear).sort((a,b) => a.Year - b.Year);

        const responseData = {
            success: true,
            message: finalData.length === 0 ? "No trend data found for the specified criteria." : "Trend data fetched.",
            data: finalData
        };
        await cacheResponse(cacheKey, responseData, 3600);
        res.status(200).json(responseData);
    } catch (error) {
        console.error("Rank trends error:", error);
        res.status(500).json({ success: false, message: "Error fetching rank trends", error: error.message });
    }
});

app.get('/filter-options', async (req, res) => { 
    const cacheKey = 'filter-options:v4';
    try {
        const cachedData = await getFromCache(cacheKey);
        if (cachedData) return res.status(200).json(cachedData);

        const [yearsResult, quotasResult, seatTypesResult, gendersResult, roundsResult, collegeTypesResult] = await Promise.all([
            pool.query('SELECT DISTINCT "Year" FROM public.combined_josaa_in ORDER BY "Year" DESC'),
            pool.query('SELECT DISTINCT "Quota" FROM public.combined_josaa_in WHERE "Quota" IS NOT NULL ORDER BY "Quota" ASC'),
            pool.query('SELECT DISTINCT "Seat Type" FROM public.combined_josaa_in WHERE "Seat Type" IS NOT NULL ORDER BY "Seat Type" ASC'),
            pool.query('SELECT DISTINCT "Gender" FROM public.combined_josaa_in WHERE "Gender" IS NOT NULL ORDER BY "Gender" ASC'),
            pool.query('SELECT DISTINCT "Round" FROM public.combined_josaa_in ORDER BY "Round" ASC'),
            pool.query('SELECT DISTINCT "College type" FROM public.combined_josaa_in WHERE "College type" IS NOT NULL AND "College type" <> \'\' ORDER BY "College type" ASC'),
        ]);
        const options = {
            years: yearsResult.rows.map(row => row.Year),
            quotas: quotasResult.rows.map(row => row.Quota),
            seatTypes: seatTypesResult.rows.map(row => row["Seat Type"]),
            genders: gendersResult.rows.map(row => row.Gender),
            rounds: roundsResult.rows.map(row => row.Round),
            instituteTypes: collegeTypesResult.rows.map(row => row["College type"]) 
        };
        
        const lowerCaseInstituteTypes = options.instituteTypes.map(it => it.toLowerCase());
        if (!lowerCaseInstituteTypes.includes('all')) {
            const allIndex = lowerCaseInstituteTypes.indexOf('all'); // Check again in case 'All' or 'ALL' exists
            if (allIndex === -1) { // If 'all' (any case) is not present
                 options.instituteTypes.unshift('All'); 
            } else { // If 'All' or 'ALL' exists, ensure it's standardized, e.g., 'All'
                 options.instituteTypes[allIndex] = 'All';
            }
        }


        await cacheResponse(cacheKey, options, 86400); 
        res.status(200).json(options);
    } catch (error) {
        console.error("Filter options error:", error);
        res.status(500).json({ success: false, message: "Error fetching filter options", error: error.message });
    }
});

app.get('/', (req, res) => { res.send('College Predictor API is running!'); });

app.use((err, req, res, next) => {
    console.error("Global error:", err.stack);
    res.status(500).json({
        success: false,
        message: "An unexpected server error.",
        error: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server started on port ${PORT}`); });
