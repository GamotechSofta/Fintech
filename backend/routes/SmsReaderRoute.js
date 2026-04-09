import express from "express";
import {
  createBulkSmsRecords,
  createSmsRecord,
  deleteSmsRecord,
  getAllSmsRecords,
  getSmsRecordById,
} from "../controllers/smsReaderController.js";

const smsReaderRouter = express.Router();

smsReaderRouter.post("/sms-reader", createSmsRecord);
smsReaderRouter.post("/sms-reader/bulk", createBulkSmsRecords);
smsReaderRouter.get("/sms-reader", getAllSmsRecords);
smsReaderRouter.get("/sms-reader/:id", getSmsRecordById);
smsReaderRouter.delete("/sms-reader/:id", deleteSmsRecord);

export default smsReaderRouter;
