import compression from 'compression';
import cors from 'cors';
import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { errorHandler, methodNotAllowedHandler, notFoundHandler } from './middlewares/ErrorHandler';
import { videoSchema } from './schemas/video';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Channel } from 'amqplib';
import { connectRabbitMQ, VideoJob, getJobStatus } from './lib/rabbitMQUtils';
import { validator } from './lib/utils';

const PORT = process.env.PORT || 3006;
const app = express();
const QUEUE_NAME = 'video-processing';

app.set('trust proxy', 1);

let channel: Channel;

// Middleware
app.use(helmet());
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(compression());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
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

        const job: VideoJob = {
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
            progress: 0
        };

        await channel.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(job)), { persistent: true });

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
        app.listen(Number(PORT), "0.0.0.0", () => {
            console.log(`Server running at http://0.0.0.0:${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();