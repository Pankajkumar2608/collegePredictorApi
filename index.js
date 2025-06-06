// server.js
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

// --- Configuration ---
const PORT = process.env.PORT || 3001;
const TABLE_NAME = "csab_final"; // !!! IMPORTANT: Change this if your table name is different !!!
const CURRENT_ACADEMIC_YEAR = new Date().getFullYear(); // Or set manually if needed

// --- Database Connection ---
const pool = new Pool({
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  port: 5432,
  ssl: {
    require: true,
  },
});

pool.on('connect', () => console.log('Connected to the Database via Pool'));
pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
  process.exit(-1);
});

// --- Express App Setup ---
const app = express();
app.use(cors({
    origin: ["https://www.motivationkaksha.com", "https://motivationkaksha.com", "http://127.0.0.1:5500"],
    credentials: true
}));
app.use(express.json());

// --- Helper Functions ---

function calculateLowerMargin(userRank) { /* ... (keep your existing function) ... */
    if (userRank === null || isNaN(userRank) || userRank < 1) return 0;
    if (userRank <= 10000) return 1500;
    if (userRank <= 20000) return 2500;
    if (userRank <= 30000) return 3200;
    if (userRank <= 40000) return 3900;
    if (userRank <= 50000) return 4500;
    if (userRank <= 60000) return 5000;
    if (userRank <= 70000) return 5500;
    if (userRank <= 80000) return 6000;
    if (userRank <= 90000) return 8500;
    if (userRank <= 100000) return 10500;
    if (userRank <= 150000) return 12500;
    if (userRank <= 210000) return 20000;
    return 30000;
}

function safeRankToIntSQL(columnName) {
    return `NULLIF(regexp_replace("${columnName}", '[^0-9]', '', 'g'), '')::integer`;
}

// --- NEW Prediction Helper Functions (Simplified from JoSAA example) ---

/**
 * Calculates probability of admission based on user's rank and a target closing rank.
 */
function getProbabilityAgainstTarget(userRank, targetRank) {
    userRank = Number(userRank);
    targetRank = Number(targetRank);

    if (isNaN(userRank) || isNaN(targetRank) || targetRank <= 0) return 0.01;

    if (userRank <= targetRank) return 0.98; // High chance if rank is better

    const diff = userRank - targetRank;
    // Simplified k_factor logic for CSAB
    const k_factor = 0.30; // Tune this: Higher means probability drops slower
    const k = Math.max(1000, targetRank * k_factor); // Min k to prevent over-sensitivity

    let probability = 0.90 * Math.exp(-diff / k);
    probability = Math.max(0.01, Math.min(probability, 0.90));
    return +probability.toFixed(3);
}

function getBaseRecommendation(probability) {
    if (probability >= 0.95) return "Excellent chance";
    if (probability >= 0.80) return "Very good chance";
    if (probability >= 0.60) return "Good chance";
    if (probability >= 0.40) return "Reasonable chance";
    if (probability >= 0.20) return "Moderate chance";
    if (probability >= 0.10) return "Low chance";
    return "Very low chance";
}

/**
 * Calculates a simplified projected closing rank.
 * @param {Array} historicalCutoffs - Array of { year, closing_rank, round } for a specific program.
 *                                   Ensure this array is sorted by year DESC, then round DESC.
 * @returns {number|null} Projected closing rank or null if not enough data.
 */
function calculateProjectedRank(historicalCutoffs) {
    if (!historicalCutoffs || historicalCutoffs.length === 0) return null;

    // Use latest round's closing rank for each year
    const latestRanksPerYear = [];
    const seenYears = new Set();
    for (const cutoff of historicalCutoffs) { // Assumes historicalCutoffs is sorted year DESC, round DESC
        if (cutoff.closing_rank !== null && !isNaN(cutoff.closing_rank) && !seenYears.has(cutoff.year)) {
            latestRanksPerYear.push({ year: cutoff.year, rank: cutoff.closing_rank });
            seenYears.add(cutoff.year);
        }
        if (latestRanksPerYear.length >= 3) break; // Consider up to last 3 available years for projection
    }

    if (latestRanksPerYear.length === 0) return null;

    // Simplified weighted average (more weight to recent years)
    let weightedRankSum = 0;
    let totalWeight = 0;
    const recencyWeights = [1.0, 0.7, 0.4]; // Weights for last 3 years

    latestRanksPerYear.slice(0, recencyWeights.length).forEach((data, index) => {
        const weight = recencyWeights[index];
        weightedRankSum += data.rank * weight;
        totalWeight += weight;
    });

    return totalWeight > 0 ? Math.round(weightedRankSum / totalWeight) : null;
}


// --- API Routes ---

app.get('/api/options', async (req, res) => { /* ... (keep your existing options endpoint) ... */
    const types = req.query.types ? req.query.types.split(',') : [];
    const optionsData = {};
    const validTypes = {
        years: '"Year"',
        rounds: '"Round"',
        quotas: '"Quota"',
        seatTypes: '"Seat Type"',
        genders: '"Gender"',
        institutes: '"Institute"',
        programs: '"Academic Program Name"'
    };

    try {
        const client = await pool.connect();
        try {
            const promises = types.map(async (type) => {
                const columnName = validTypes[type];
                if (!columnName) return;

                const queryText = `SELECT DISTINCT ${columnName} FROM "${TABLE_NAME}" WHERE ${columnName} IS NOT NULL AND ${columnName}::text <> '' ORDER BY ${columnName} ASC`;
                const result = await client.query(queryText);
                optionsData[type] = result.rows.map(row => row[Object.keys(row)[0]]);

                if (type === 'years') {
                    optionsData[type].sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
                }
                 if (type === 'rounds') {
                    optionsData[type].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
                }
            });
            await Promise.all(promises);
            res.json(optionsData);
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("Error fetching dropdown options:", err);
        res.status(500).json({ message: "Error fetching filter options." });
    }
});

app.get('/api/colleges', async (req, res) => {
    const {
        rank, seatType, year: selectedYear, round: selectedRound, quota, gender, institute, program,
        page = 1, limit = 25, fetchAll = 'false'
    } = req.query;

    if (!seatType) {
        return res.status(400).json({ message: "Seat Type (Category) is required." });
    }
    const userRank = rank ? parseInt(rank, 10) : null;
    if (rank && (isNaN(userRank) || userRank < 1)) {
        return res.status(400).json({ message: "Invalid Rank provided." });
    }
    const currentPage = parseInt(page, 10) || 1;
    const itemsPerPage = parseInt(limit, 10) || 25;
    const offset = (currentPage - 1) * itemsPerPage;
    const shouldFetchAll = fetchAll === 'true';

    let client;
    try {
        client = await pool.connect();

        // --- Stage 1: Initial Filtering (mostly based on latest year if not specified) ---
        let initialFilterParams = [];
        let initialParamIndex = 1;
        let initialWhereClauses = [`"Seat Type" = $${initialParamIndex++}`];
        initialFilterParams.push(seatType);

        let effectiveYear = selectedYear ? parseInt(selectedYear, 10) : null;
        let effectiveRound = selectedRound ? parseInt(selectedRound, 10) : null;

        // Determine latest year/round if not provided
        if (!effectiveYear) {
            const latestYearResult = await client.query(`SELECT MAX("Year") as max_year FROM "${TABLE_NAME}"`);
            if (latestYearResult.rows.length > 0 && latestYearResult.rows[0].max_year) {
                effectiveYear = parseInt(latestYearResult.rows[0].max_year, 10);
            }
        }
        if (effectiveYear && !effectiveRound) {
            const latestRoundResult = await client.query(`SELECT MAX("Round") as max_round FROM "${TABLE_NAME}" WHERE "Year" = $1`, [effectiveYear]);
            if (latestRoundResult.rows.length > 0 && latestRoundResult.rows[0].max_round) {
                effectiveRound = parseInt(latestRoundResult.rows[0].max_round, 10);
            }
        }
        
        // Add year and round to initial filter if determined/selected
        if (effectiveYear) { initialWhereClauses.push(`"Year" = $${initialParamIndex++}`); initialFilterParams.push(effectiveYear); }
        if (effectiveRound) { initialWhereClauses.push(`"Round" = $${initialParamIndex++}`); initialFilterParams.push(effectiveRound); }


        if (quota) { initialWhereClauses.push(`"Quota" = $${initialParamIndex++}`); initialFilterParams.push(quota); }
        if (gender) { initialWhereClauses.push(`"Gender" = $${initialParamIndex++}`); initialFilterParams.push(gender); }
        if (institute) { initialWhereClauses.push(`"Institute" = $${initialParamIndex++}`); initialFilterParams.push(institute); }
        if (program) {
            initialWhereClauses.push(`"Academic Program Name" ILIKE $${initialParamIndex++}`);
            initialFilterParams.push(`%${program}%`);
        }

        const specificInstituteSelected = !!institute;
        if (userRank && !specificInstituteSelected) {
            const lowerMargin = calculateLowerMargin(userRank);
            const minAllowedRank = Math.max(1, userRank - lowerMargin);
            // This rank filter is a bit broad initially, projection will refine
            initialWhereClauses.push(`${safeRankToIntSQL("Closing Rank")} >= $${initialParamIndex++}`);
            initialFilterParams.push(minAllowedRank - 5000); // Widen a bit more for initial fetch
            initialWhereClauses.push(`${safeRankToIntSQL("Closing Rank")} <= $${initialParamIndex++}`);
            initialFilterParams.push(userRank + 2 * calculateLowerMargin(userRank)); // And widen on the upper end too
        }
        initialWhereClauses.push(`${safeRankToIntSQL("Closing Rank")} IS NOT NULL`); // Ensure closing rank exists

        const initialWhereString = `WHERE ${initialWhereClauses.join(" AND ")}`;
        const initialSelect = `
            SELECT DISTINCT "Institute", "Academic Program Name", "Quota", "Seat Type", "Gender",
                   MAX("Year") as "Year", MAX("Round") as "Round", -- Get latest year/round for this distinct group
                   ${safeRankToIntSQL("Opening Rank")} as opening_rank,
                   ${safeRankToIntSQL("Closing Rank")} as closing_rank 
            FROM "${TABLE_NAME}"
            ${initialWhereString}
            GROUP BY "Institute", "Academic Program Name", "Quota", "Seat Type", "Gender", opening_rank, closing_rank 
            LIMIT 500`; // Limit initial candidates for performance
        
        const initialResults = await client.query(initialSelect, initialFilterParams);
        let candidates = initialResults.rows.map(row => ({
            ...row,
            program_name: row["Academic Program Name"], // Alias for consistency
            seat_type: row["Seat Type"], // Alias
        }));

        if (candidates.length === 0) {
            return res.json({ results: [], totalCount: 0, currentPage: 1, totalPages: 1 });
        }

        // --- Stage 2: Fetch Historical Data for Projection (if userRank is provided) ---
        let processedResults = [];
        if (userRank) {
            const historicalDataPromises = candidates.map(async (candidate) => {
                const historyQuery = `
                    SELECT "Year" as year, "Round" as round, ${safeRankToIntSQL("Closing Rank")} as closing_rank
                    FROM "${TABLE_NAME}"
                    WHERE "Institute" = $1 AND "Academic Program Name" = $2 AND "Quota" = $3
                      AND "Seat Type" = $4 AND "Gender" = $5 AND ${safeRankToIntSQL("Closing Rank")} IS NOT NULL
                    ORDER BY "Year" DESC, "Round" DESC
                `;
                const historyParams = [candidate.Institute, candidate["Academic Program Name"], candidate.Quota, candidate["Seat Type"], candidate.Gender];
                const historyResult = await client.query(historyQuery, historyParams);

                const projectedRank = calculateProjectedRank(historyResult.rows);
                let probability = 0;
                let recommendation = getBaseRecommendation(0);

                if (projectedRank !== null) {
                    probability = getProbabilityAgainstTarget(userRank, projectedRank);
                    recommendation = getBaseRecommendation(probability);
                } else {
                    // Fallback to using current year's closing rank if no projection possible
                    if (candidate.closing_rank !== null) {
                        probability = getProbabilityAgainstTarget(userRank, candidate.closing_rank);
                        recommendation = getBaseRecommendation(probability);
                    }
                }
                
                return {
                    ...candidate,
                    projected_rank: projectedRank,
                    probability: probability,
                    recommendation: recommendation,
                    // Use the closing_rank from the initial query (latest year/round selected) for display
                    // The 'closing_rank' in candidate is already the one from the specified/latest year/round
                };
            });
            processedResults = await Promise.all(historicalDataPromises);

            // --- Stage 3: Sort Processed Results ---
            processedResults.sort((a, b) => {
                // Primary sort: Probability (descending)
                if (b.probability !== a.probability) {
                    return b.probability - a.probability;
                }
                // Secondary sort: User rank vs Projected rank
                // Prefer colleges where user_rank <= projected_rank
                const a_isSafer = userRank <= (a.projected_rank || a.closing_rank || Infinity);
                const b_isSafer = userRank <= (b.projected_rank || b.closing_rank || Infinity);

                if (a_isSafer && !b_isSafer) return -1;
                if (!a_isSafer && b_isSafer) return 1;

                // If both are "safer" or "riskier", sort by how close the projected/actual rank is
                const diffA = Math.abs((a.projected_rank || a.closing_rank || Infinity) - userRank);
                const diffB = Math.abs((b.projected_rank || b.closing_rank || Infinity) - userRank);
                if (diffA !== diffB) {
                    return diffA - diffB; // Smaller difference first
                }
                
                // Fallback sorting
                if (a.Institute.localeCompare(b.Institute) !== 0) {
                    return a.Institute.localeCompare(b.Institute);
                }
                return a.program_name.localeCompare(b.program_name);
            });

        } else { // No user rank, just sort by institute and program
            processedResults = candidates.sort((a, b) => {
                if (a.Institute.localeCompare(b.Institute) !== 0) {
                    return a.Institute.localeCompare(b.Institute);
                }
                if (a.program_name.localeCompare(b.program_name) !== 0) {
                    return a.program_name.localeCompare(b.program_name);
                }
                return (a.closing_rank || Infinity) - (b.closing_rank || Infinity);
            });
        }
        
        // --- Stage 4: Pagination ---
        const totalCount = processedResults.length;
        const paginatedResults = shouldFetchAll ? processedResults : processedResults.slice(offset, offset + itemsPerPage);

        const finalResultsWithId = paginatedResults.map(row => ({
            id: `${row.Institute}-${row.program_name}-${row.Quota}-${row.seat_type}-${row.Gender}-${row.Year}-${row.Round}`.toLowerCase().replace(/[^a-z0-9\-_]/g, "-").replace(/-+/g,'-').replace(/^-+|-+$/g, ''),
            ...row
        }));

        res.json({
            results: finalResultsWithId,
            totalCount: totalCount,
            currentPage: shouldFetchAll ? 1 : currentPage,
            totalPages: shouldFetchAll ? 1 : Math.ceil(totalCount / itemsPerPage),
            appliedFilters: { // Send back what was effectively used
                seatType, effectiveYear, effectiveRound, quota, gender, institute, program, userRank
            }
        });

    } catch (err) {
        console.error("Database Query Error in /api/colleges:", err);
        res.status(500).json({ message: "Error fetching college data." });
    } finally {
        if (client) client.release();
    }
});


app.get('/api/trends', async (req, res) => { /* ... (keep your existing trends endpoint) ... */
    const { institute, program, quota, seatType, gender, round } = req.query;

    if (!institute || !program || !quota || !seatType || !gender || !round) {
        return res.status(400).json({ message: "Missing required parameters for trend data." });
    }

    const queryText = `
        SELECT "Year" as year, ${safeRankToIntSQL("Opening Rank")} as opening_rank, ${safeRankToIntSQL("Closing Rank")} as closing_rank
        FROM "${TABLE_NAME}"
        WHERE "Institute" = $1
          AND "Academic Program Name" = $2
          AND "Quota" = $3
          AND "Seat Type" = $4
          AND "Gender" = $5
          AND "Round" = $6 
          AND ${safeRankToIntSQL("Closing Rank")} IS NOT NULL
        ORDER BY "Year" ASC
    `;
    const queryParams = [institute, program, quota, seatType, gender, parseInt(round, 10)];

    try {
        const client = await pool.connect();
        try {
            const result = await client.query(queryText, queryParams);
            res.json(result.rows);
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("Error fetching trend data:", err);
        res.status(500).json({ message: "Error fetching trend data." });
    }
});

app.get('/', (req, res) => res.send('College Predictor API is running!'));

app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err.stack || err);
  res.status(500).json({ message: err.message || 'Something went wrong on the server!' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
