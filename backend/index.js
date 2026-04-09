import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import connectDB from "./config/db.js";
import extractionRouter from "./routes/ExtractionRoute.js";
import smsReaderRouter from "./routes/SmsReaderRoute.js";
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.send("Hello World");
});
await connectDB();

app.use("/api/v1", smsReaderRouter);
app.use("/api/v1", extractionRouter);

app.listen(process.env.PORT, "0.0.0.0", () => {
  console.log(`Server is running on http://0.0.0.0:${process.env.PORT}`);
}); 
