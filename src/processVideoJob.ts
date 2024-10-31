import fs from 'fs/promises';
import path from 'path';
import { supabase } from './db';
import { generateStory, textToAudio, cleanupTempFiles, merge, addAudioToVideo, addSubtitles } from './lib/VideoUtils';
import ffmpeg from 'fluent-ffmpeg';
import axios from 'axios';
import { updateJobStatus } from './lib/rabbitMQUtils';
import { ensureDirectoryExists } from './lib/utils';
import { NewVideoJob, Subtitle } from './lib/types';

export async function processVideoJob(job: any) {
    const { sessionId, urls, text, voiceId, isHasScript, VideoStart, VideoEnd, subtitles, voiceOver, aspectRatio } = job.data;
    const tempDir = path.join(__dirname, 'temp', sessionId);
    await ensureDirectoryExists(tempDir);

    const tempFiles: string[] = [];
    const timings: { [key: string]: number } = {};
    const startTime = Date.now();

    try {
        await updateJobStatus(job.id, 'processing', 10);

        // Start merging videos immediately
        const mergeStartTime = Date.now();
        const mergePromise = merge(urls, tempDir, aspectRatio);

        // Concurrently generate story and audio if needed
        let audioGenerationPromise;
        if (voiceOver || subtitles) {
            const scriptStartTime = Date.now();
            const scriptPromise = isHasScript ? Promise.resolve(text) : generateStory(text, VideoStart, VideoEnd);
            audioGenerationPromise = scriptPromise.then(script => {
                timings['scriptGeneration'] = Date.now() - scriptStartTime;
                const audioStartTime = Date.now();
                return textToAudio(script, tempDir, voiceId, subtitles).then(result => {
                    timings['audioGeneration'] = Date.now() - audioStartTime;
                    return result;
                });
            });
        }

        // Wait for video merging to complete
        const mergedVideoPath = await mergePromise;
        timings['videoMerging'] = Date.now() - mergeStartTime;
        tempFiles.push(mergedVideoPath);
        let finalVideoPath = mergedVideoPath;

        await updateJobStatus(job.id, 'processing', 30);

        if (voiceOver || subtitles) {
            const { audioPath, subtitlePath } = await audioGenerationPromise!;
            if (voiceOver) tempFiles.push(audioPath);
            if (subtitles) tempFiles.push(subtitlePath);

            await updateJobStatus(job.id, 'processing', 50);

            // Perform audio and subtitle addition concurrently if both are required
            let audioAdditionPromise, subtitleAdditionPromise;

            if (voiceOver) {
                const audioAdditionStartTime = Date.now();
                const videoWithAudioPath = path.join(tempDir, 'video-with-audio.mp4');
                audioAdditionPromise = addAudioToVideo(mergedVideoPath, audioPath, videoWithAudioPath)
                    .then(() => {
                        timings['audioAddition'] = Date.now() - audioAdditionStartTime;
                        tempFiles.push(videoWithAudioPath);
                        finalVideoPath = videoWithAudioPath;
                        console.log(`Video with audio path: ${finalVideoPath}`);
                    });
            }

            if (subtitles) {
                subtitleAdditionPromise = (async () => {
                    await updateJobStatus(job.id, 'processing', 70);
                    const subtitleAdditionStartTime = Date.now();
                    const videoWithSubtitlesPath = path.join(tempDir, 'final-video.mp4');
                    console.log(`Adding subtitles to video: ${finalVideoPath}, Subtitles: ${subtitlePath}`);
                    await addSubtitles(finalVideoPath, subtitlePath, videoWithSubtitlesPath);
                    timings['subtitleAddition'] = Date.now() - subtitleAdditionStartTime;
                    tempFiles.push(videoWithSubtitlesPath);
                    finalVideoPath = videoWithSubtitlesPath;
                    console.log(`Final video with subtitles path: ${finalVideoPath}`);
                })();
            }

            // Wait for both operations to complete
            await Promise.all([audioAdditionPromise, subtitleAdditionPromise].filter(Boolean));
        }

        await updateJobStatus(job.id, 'processing', 90);

        // Read file and upload to Supabase concurrently
        const uploadStartTime = Date.now();
        const [fileBuffer,] = await Promise.all([
            fs.readFile(finalVideoPath),
            updateJobStatus(job.id, 'processing', 95)
        ]);

        const uniqueFileName = `${Date.now()}-${sessionId}-final-video.mp4`;
        const { data, error } = await supabase
            .storage
            .from('videos')
            .upload(uniqueFileName, fileBuffer, {
                contentType: 'video/mp4',
            });

        if (error) {
            throw new Error(`Supabase upload error: ${error.message}`);
        }

        timings['supabaseUpload'] = Date.now() - uploadStartTime;

        const totalProcessingTime = Date.now() - startTime;
        timings['total'] = totalProcessingTime;

        console.log(`Job ${job.id} completed. Total processing time: ${totalProcessingTime}ms`);
        console.log(`Detailed timings for job ${job.id}:`, JSON.stringify(timings, null, 2));

        await updateJobStatus(job.id, 'completed', 100, { ...data, processingTime: totalProcessingTime, timings });

        return { ...data, processingTime: totalProcessingTime, timings };
    } catch (error) {
        console.error('Error processing video job:', error);
        await updateJobStatus(job.id, 'failed', 0, null);
        throw error;
    } finally {
        await cleanupTempFiles(tempFiles);
        await fs.rm(tempDir, { recursive: true, force: true }).catch(err =>
            console.error(`Error deleting temporary directory ${tempDir}:`, err)
        );
    }
}

//     const { sessionId, subtitles, audioFileUrl, imagesList } = job.data;
//     const tempDir = path.join(__dirname, 'temp', sessionId);
//     await ensureDirectoryExists(tempDir);
//     const tempFiles: string[] = [];

//     try {
//         await updateJobStatus(job.id, 'processing', 10);


//     } catch (error) {
//         console.error('Error processing video job:', error);
//         await updateJobStatus(job.id, 'failed', 0, null);
//         throw error;
//     } finally {
//         await cleanupTempFiles(tempFiles);
//         await fs.rm(tempDir, { recursive: true, force: true }).catch(err =>
//             console.error(`Error deleting temporary directory ${tempDir}:`, err)
//         );
//     }
// }



// Define ImageItem and NewVideoJob interfaces
async function downloadFile(url: string, outputPath: string): Promise<void> {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    await fs.writeFile(outputPath, response.data);
}

async function createSubtitlesFile(subtitles: Subtitle[], outputPath: string, videoDuration: number): Promise<void> {
    let srtContent = '';
    subtitles.forEach((sub, index) => {
        const startTime = formatTimestamp(sub.start);
        let endTime = formatTimestamp(sub.end);

        // Extend the last subtitle to cover the remaining video duration if audio ends early
        if (index === subtitles.length - 1 && sub.end < videoDuration * 1000) {
            endTime = formatTimestamp(videoDuration * 1000); // Extend to the video end
        }

        srtContent += `${index + 1}\n${startTime} --> ${endTime}\n${sub.text}\n\n`;
    });
    await fs.writeFile(outputPath, srtContent);
}

function formatTimestamp(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = ms % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

// Create video from images
async function createSlidesVideo(images: string[], duration: number, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const durationPerImage = duration / images.length;
        const command = ffmpeg();

        // Add each image as input with a labeled stream
        images.forEach((image, index) => {
            command.input(image)
                .inputOptions(`-t ${durationPerImage}`);
        });

        // Apply scaling, padding, and set time for each image stream
        const filterComplex = images.map((_, index) =>
            `[${index}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS[v${index}]`
        );

        // Concatenate all the image video streams
        command
            .complexFilter([...filterComplex, `concat=n=${images.length}:v=1:a=0[outv]`], 'outv') // Map output to 'outv'
            .outputOptions(['-c:v libx264', '-r 30', '-pix_fmt yuv420p'])
            .output(outputPath)
            .on('end', () => resolve())
            .on('error', reject)
            .run();
    });
}
async function validateVideo(videoPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                reject(err);
                return;
            }

            const duration = metadata.format.duration;
            if (!duration || duration <= 0) {
                reject(new Error(`Invalid video duration: ${duration} seconds`));
                return;
            }

            console.log(`Video validation successful. Duration: ${duration} seconds`);
            resolve();
        });
    });
}

export async function collectVideoJob(job: NewVideoJob): Promise<string> {
    const { sessionId, subtitles, audioFileUrl, imagesList } = job.data;
    const tempDir = path.join(__dirname, 'temp', sessionId);
    await fs.mkdir(tempDir, { recursive: true });
    const tempFiles: string[] = [];

    try {
        await updateJobStatus(job.id, 'processing', 10);

        // Download audio file
        const audioPath = path.join(tempDir, 'audio.mp3');
        await downloadFile(audioFileUrl, audioPath);
        tempFiles.push(audioPath);

        // Get audio duration
        const audioDuration = await new Promise<number>((resolve, reject) => {
            ffmpeg.ffprobe(audioPath, (err, metadata) => {
                if (err) reject(err);
                const duration = metadata.format.duration || 0;
                if (duration <= 0) {
                    reject(new Error('Invalid audio duration detected'));
                }
                resolve(duration);
            });
        });

        // Download images
        const imagePaths = await Promise.all(imagesList.map(async (image) => {
            const imagePath = path.join(tempDir, image.path);
            await downloadFile(`https://hyzgqhhzdudntmbczpun.supabase.co/storage/v1/object/public/ai-images/${image.path}`, imagePath);
            return imagePath;
        }));

        // Create subtitles file
        const subtitlesPath = path.join(tempDir, 'subtitles.srt');
        await createSubtitlesFile(subtitles.transcript, subtitlesPath, audioDuration);
        tempFiles.push(subtitlesPath);

        // Create video from images
        const imageVideoPath = path.join(tempDir, 'image_video.mp4');
        await createSlidesVideo(imagePaths, audioDuration, imageVideoPath);
        tempFiles.push(imageVideoPath);

        // Validate the created video
        await validateVideo(imageVideoPath);

        // Final output path
        const videoWithSubtitlesPath = path.join(tempDir, 'video-with-subtitles.mp4');
        await addSubtitles(imageVideoPath, subtitlesPath, videoWithSubtitlesPath);
        const outputPath = path.join(tempDir, 'final_video.mp4');

        // Create final video with audio
        await new Promise<void>((resolve, reject) => {
            ffmpeg()
                .input(videoWithSubtitlesPath)
                .input(audioPath)
                .outputOptions([
                    '-c:v', 'libx264',
                    '-preset', 'medium',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-af', 'apad', // Add silence if audio is shorter
                    '-shortest',    // Ensure video and audio stop at the shortest length
                ])
                .output(outputPath)
                .on('end', () => resolve())
                .on('error', reject)
                .run();
        });

        // Validate the final video
        await validateVideo(outputPath);

        await updateJobStatus(job.id, 'completed', 100, outputPath);
        return outputPath;

    } catch (error) {
        console.error('Error processing video job:', error);
        await updateJobStatus(job.id, 'failed', 0, null);
        throw error;
    }
}
