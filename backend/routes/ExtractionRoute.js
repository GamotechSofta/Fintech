import express from "express";
import {
  extractBulk,
  extractSingle,
} from "../controllers/extractionController.js";

const extractionRouter = express.Router();

extractionRouter.post("/extract", extractSingle);
extractionRouter.post("/extract/bulk", extractBulk);

export default extractionRouter;
