import type { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import fs from 'fs';


export const ensureDirectoryExists = (directory: string) => {
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }
};

export const validator = (schema: z.Schema) => async (req: Request, res: Response, next: NextFunction) => {
    try {
        await schema.parseAsync(req.body);
        return next();
    } catch (error) {
        return res.status(400).send({
            status: "fail",
            code: 400,
            // @ts-ignore
            data: error?.errors,
        });
    }
};



export function formatTime(seconds: number): string {
    const date = new Date(seconds * 1000);
    const hours = date.getUTCHours().toString().padStart(2, '0');
    const minutes = date.getUTCMinutes().toString().padStart(2, '0');
    const secs = date.getUTCSeconds().toString().padStart(2, '0');
    const ms = date.getUTCMilliseconds().toString().padStart(3, '0');
    return `${hours}:${minutes}:${secs},${ms}`;
}