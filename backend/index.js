import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import connectDB from "./config/db.js";
import extractionRouter from "./routes/ExtractionRoute.js";
import smsReaderRouter from "./routes/SmsReaderRoute.js";
import webhookRouter from "./routes/webhook.js";
dotenv.config();

const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf?.toString("utf8") || "";
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.send("Hello World");
});
await connectDB();

app.use("/api/v1", smsReaderRouter);
app.use("/api/v1", extractionRouter);
app.use("/api/v1", webhookRouter);

app.listen(process.env.PORT, () => {
  console.log(`Server is running on http://localhost:${process.env.PORT}`);
});
