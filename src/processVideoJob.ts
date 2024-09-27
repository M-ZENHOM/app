import fs from 'fs/promises';
import path from 'path';
import { supabase } from './db';
import { addAudioToVideo, addSubtitles, cleanupTempFiles, generateStory, merge, textToAudio } from './lib/VideoUtils';
import { ensureDirectoryExists } from './lib/utils';
import { VideoJob, updateJobStatus } from './lib/rabbitMQUtils';

export async function processVideoJob(job: VideoJob) {
    const { sessionId, urls, text, voiceId, isHasScript, VideoStart, VideoEnd, subtitles, voiceOver, aspectRatio } = job.data;
    const tempDir = path.join(__dirname, 'temp', sessionId);
    await ensureDirectoryExists(tempDir);

    const tempFiles: string[] = [];

    try {
        await updateJobStatus(job.id, 'processing', 10);
        const mergedVideoPath = await merge(urls, tempDir, aspectRatio);
        tempFiles.push(mergedVideoPath);

        let finalVideoPath = mergedVideoPath;

        if (voiceOver || subtitles) {
            await updateJobStatus(job.id, 'processing', 30);
            const scriptOrNo: string = isHasScript ? text : await generateStory(text, VideoStart, VideoEnd);
            const { audioPath, subtitlePath } = await textToAudio(scriptOrNo, tempDir, voiceId, subtitles);
            if (voiceOver) {
                tempFiles.push(audioPath);
            }
            if (subtitles) {
                tempFiles.push(subtitlePath);
            }

            if (voiceOver) {
                await updateJobStatus(job.id, 'processing', 50);
                const videoWithAudioPath = path.join(tempDir, 'video-with-audio.mp4');
                await addAudioToVideo(mergedVideoPath, audioPath, videoWithAudioPath);
                tempFiles.push(videoWithAudioPath);
                finalVideoPath = videoWithAudioPath;
            }

            if (subtitles) {
                await updateJobStatus(job.id, 'processing', 70);
                const videoWithSubtitlesPath = path.join(tempDir, 'final-video.mp4');
                await addSubtitles(finalVideoPath, subtitlePath, videoWithSubtitlesPath);
                tempFiles.push(videoWithSubtitlesPath);
                finalVideoPath = videoWithSubtitlesPath;
            }
        }

        await updateJobStatus(job.id, 'processing', 90);
        const fileBuffer = await fs.readFile(finalVideoPath);
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

        await updateJobStatus(job.id, 'completed', 100, data);

        return data;
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