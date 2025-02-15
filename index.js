import express from 'express';
import cors from 'cors';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({
    origin: ["https://www.motivationkaksha.com", "https://motivationkaksha.com"],
    credentials: true
}));

const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.DB_PORT,
    ssl: true,
});

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

    let filterQuery = `
        SELECT *, ABS("Opening Rank" - $1) AS rank_diff 
        FROM public.combined_josaa_in 
        WHERE 1=1
    `;
    const params = [userRank];
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
    if (userRank) {
        filterQuery += ` AND "Opening Rank" <= $${paramIndex} AND "Closing Rank" >= $${paramIndex}`;
        params.push(userRank);
        paramIndex++;
        filterQuery += ` ORDER BY rank_diff ASC `;
    } else {
        filterQuery += ` ORDER BY "Opening Rank" ASC `;
    }
    try {
        const result = await pool.query(filterQuery, params);
        if(!result.rows.length === 0){
            res.status(200).json({
                data: "No match found for the given criteria"
            })
        }
        res.status(200).json({
            filterData: result.rows
        });
    } catch (error) {
        res.status(400).json({
            message: "Error in fetching data"
        });
    }
});
app.get('/suggest', async (req, res) => {
    const { term } = req.query;
    console.log(term)
    // Split search term into individual words
    const searchTerms = term.trim().split(/\s+/);
    console.log(searchTerms)
    if(searchTerms.length === 0){
        res.status(400).json({
            message: "Please enter a search term"
        })
    }
    if(searchTerms.length == 1){
        const patterns = searchTerms[0]
        console.log(patterns)
        try {
            const result = await pool.query(
                `SELECT DISTINCT institute 
                 FROM public.combined_josaa_in
                 WHERE institute ILIKE '%${patterns}%'
                 ORDER BY institute ASC`
            );
            console.log(result.rows)    

            res.json(result.rows.map(r => r.institute));
        } catch (error) {
            console.error("Autocomplete error:", error);
            res.status(500).json([]);
        }
    }
    else{
        const patterns = searchTerms[1];
        console.log(patterns)
        try {
            const result = await pool.query(
                `SELECT DISTINCT institute 
                 FROM public.combined_josaa_in
                 WHERE institute ILIKE '%${patterns}%'
                 ORDER BY institute ASC`
            );
            console.log(result.rows)    

            res.json(result.rows.map(r => r.institute));
        } catch (error) {
            console.error("Autocomplete error:", error);
            res.status(500).json([]);
        } 
    }
});
app.listen(3000, () => {
    console.log('Server started on port 3000');
});
