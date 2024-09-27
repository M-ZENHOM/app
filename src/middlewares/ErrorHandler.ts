import { NextFunction, Request, Response } from "express";
import { ErrorType } from "../lib/types";

const createErrorResponse = (statusCode: number, statusText: string, message: string) => ({
    status: statusText,
    code: statusCode,
    message,
    data: null,
});

export const errorHandler = (error: ErrorType, req: Request, res: Response, next: NextFunction) => {
    const statusCode = error.statusCode || 500;
    const statusText = error.statusText || "error";
    const response = createErrorResponse(statusCode, statusText, error.message);
    res.status(statusCode).json(response);
};

export const methodNotAllowedHandler = (req: Request, res: Response) => {
    const statusCode = 405;
    const statusText = "fail";
    const message = `Method ${req.method} not allowed for ${req.originalUrl}`;
    const response = createErrorResponse(statusCode, statusText, message);
    res.status(statusCode).json(response);
};

export const notFoundHandler = (req: Request, res: Response) => {
    const statusCode = 404;
    const statusText = "fail";
    const message = `Can't find ${req.originalUrl} on this server`;
    const response = createErrorResponse(statusCode, statusText, message);
    res.status(statusCode).json(response);
};