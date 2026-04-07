import express from "express";
import { registerUser, getUsers, getUserById, deleteUser } from "../controllers/userController.js";

const userRouter = express.Router();

userRouter.post("/register", registerUser);
userRouter.get("/users", getUsers);
userRouter.get("/users/:id", getUserById);
userRouter.delete("/users/:id", deleteUser);

export default userRouter;