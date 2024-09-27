import { z } from "zod";


export const videoSchema = z.object({
    urls: z.array(z.string()),
    text: z.string(),
    voiceId: z.string(),
    isHasScript: z.boolean(),
    VideoStart: z.string(),
    VideoEnd: z.string(),
    subtitles: z.boolean(),
    voiceOver: z.boolean(),
});