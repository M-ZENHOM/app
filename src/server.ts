import { Channel } from 'amqplib';
import compression from 'compression';
import cors from 'cors';
import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';
import { connectRabbitMQ, getJobStatus, getQueueMessageCount, updateJobStatus } from './lib/rabbitMQUtils';
import { ImageJob } from './lib/types';
import { validator } from './lib/utils';
import { errorHandler, methodNotAllowedHandler, notFoundHandler } from './middlewares/ErrorHandler';
import { videoSchema } from './schemas/video';

const PORT = process.env.PORT || 3006;
const app = express();
const QUEUE_NAME = 'video-processing';

let channel: Channel;

// Middleware
app.use(helmet());
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(compression());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Routes
app.get('/', (_req: Request, res: Response) => {
    res.send('Video Processing Server');
});

app.post('/processing-video', validator(videoSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { urls, text, voiceId, isHasScript, VideoStart, VideoEnd, subtitles, voiceOver, aspectRatio } = req.body;
        const sessionId = uuidv4();
        const startTime = Date.now();

        const job = {
            id: sessionId,
            data: {
                sessionId,
                urls,
                text,
                voiceId,
                isHasScript,
                VideoStart,
                VideoEnd,
                subtitles,
                voiceOver,
                aspectRatio
            },
            status: 'queued',
            progress: 0,
            startTime
        };

        await updateJobStatus(job.id, 'queued', 0);

        await channel.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(job)), {
            persistent: true,
            priority: 5 // Default priority
        });

        res.json({ message: 'Video processing job added to queue', videoId: sessionId });
    } catch (error) {
        next(error);
    }
});

app.get('/processing-video-status/:jobId', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { jobId } = req.params;
        const jobStatus = await getJobStatus(jobId);

        if (!jobStatus) {
            return res.status(404).json({ message: 'Job not found' });
        }

        if (jobStatus.status === 'completed' && jobStatus.result) {
            console.log(`Job ${jobId} completed. Total processing time: ${jobStatus.result.processingTime}ms`);
            console.log(`Detailed timings for job ${jobId}:`, JSON.stringify(jobStatus.result.timings, null, 2));
        }

        res.json(jobStatus);
    } catch (error) {
        next(error);
    }
});

app.get('/queue-status', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const messageCount = await getQueueMessageCount(channel);
        res.json({ queuedJobs: messageCount });
    } catch (error) {
        next(error);
    }
});

app.post('/processing-image', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { imagesList, audioFileUrl, subtitles } = req.body;
        const sessionId = uuidv4();
        const startTime = Date.now();

        const job: ImageJob = {
            id: sessionId,
            data: {
                sessionId,
                imagesList,
                audioFileUrl,
                subtitles
            },
            status: 'queued',
            progress: 0,
            startTime
        };

        await updateJobStatus(job.id, 'queued', 0);

        await channel.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(job)), {
            persistent: true,
            priority: 5
        });

        res.json({
            message: 'Image processing job added to queue',
            imageId: sessionId,
            status: 'queued'
        });
    } catch (error) {
        next(error);
    }
});

app.get('/processing-image-status/:jobId', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { jobId } = req.params;
        const jobStatus = await getJobStatus(jobId);

        if (!jobStatus) {
            return res.status(404).json({
                message: 'Job not found'
            });
        }

        res.json(jobStatus);
    } catch (error) {
        next(error);
    }
});

app.use(errorHandler);
app.use(methodNotAllowedHandler);
app.all("*", notFoundHandler);

async function startServer() {
    try {
        channel = await connectRabbitMQ();
        await channel.prefetch(1);

        app.listen(Number(PORT), "0.0.0.0", () => {
            console.log(`Server running at http://0.0.0.0:${PORT}`);
        });

        process.on('SIGTERM', async () => {
            console.log('SIGTERM signal received: closing HTTP server');
            await channel.close();
            process.exit(0);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();