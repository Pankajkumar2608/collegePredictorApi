import express from 'express';
import cors from 'cors';

import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config();



const app = express();
app.use(express.json());
app.use(cors());


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
        
        res.status(200).json({
            filterData: result.rows
        });
    } catch (error) {
        
        res.status(400).json({
            message: "Error in fetching data"
        });
    }
});


app.listen(3000, () => {
    console.log('Server started on port 3000');
});
