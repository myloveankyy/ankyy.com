/* --- backend/server.js (The Universal Engine) --- */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http'); 
const { Server } = require('socket.io'); 
const mongoose = require('mongoose'); 
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpegPath = require('ffmpeg-static');
const archiver = require('archiver');
const multer = require('multer');

// --- ENVIRONMENT DETECTION ---
// Check if we are running on Windows or Linux
const IS_WINDOWS = process.platform === 'win32';
const BINARY_NAME = IS_WINDOWS ? 'yt-dlp.exe' : 'yt-dlp';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 5000;
// Use Environment Variable for DB or fallback to local
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/musicbox'; 

// --- APP & SERVER SETUP ---
const app = express();
const server = http.createServer(app); 

// Allow connections from Localhost OR the Live Domain
const ALLOWED_ORIGINS = [
    "http://localhost:3000", 
    "http://localhost:3001",
    "https://ankyy.com",
    "https://admin.ankyy.com"
];

const io = new Server(server, {
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ["GET", "POST"]
    }
});

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- STATIC PATHS ---
const downloadDir = path.join(__dirname, 'downloads');
const uploadDir = path.join(__dirname, 'uploads');

// Ensure folders exist on startup
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

app.use('/downloads', express.static(downloadDir));
app.use('/uploads', express.static(uploadDir));

// --- IMAGE UPLOAD STORAGE ENGINE ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- MONGODB CONNECTION ---
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- SCHEMAS ---
const FileSchema = new mongoose.Schema({
    id: { type: Number, required: true, unique: true },
    title: String,
    filename: String,
    type: String,
    quality: String,
    effect: String,
    thumbnail: String,
    date: { type: Date, default: Date.now },
    size: String,
    status: String,
    downloadDuration: Number
});

const BlogSchema = new mongoose.Schema({
    slug: { type: String, unique: true, required: true, index: true },
    title: { type: String, required: true },
    content: { type: String, required: true }, 
    excerpt: String, 
    featuredImage: String,
    tags: [String],
    status: { type: String, default: 'draft' }, 
    views: { type: Number, default: 0 },
    date: { type: Date, default: Date.now }
});

const FileModel = mongoose.model('File', FileSchema);
const BlogModel = mongoose.model('Blog', BlogSchema);

// --- HELPER: CLEAN SLUG ---
const cleanSlug = (text) => {
    if (!text) return '';
    return text.toString().toLowerCase()
        .trim()
        .replace(/[\s\W-]+/g, '-') 
        .replace(/^-+|-+$/g, ''); 
};

// --- CORE ENGINE SETUP (THE FIX) ---
process.on('uncaughtException', (err) => console.error('CRITICAL ERROR:', err));
process.on('unhandledRejection', (r, p) => console.error('Unhandled Rejection:', p, r));

// Define path based on OS
const binaryPath = path.join(__dirname, BINARY_NAME);
let ytDlpWrap;

const ensureBinaryExists = async () => {
    // If binary missing, download it
    if (!fs.existsSync(binaryPath)) {
        console.log(`⏳ Downloading ${BINARY_NAME}...`);
        try { 
            await YTDlpWrap.downloadFromGithub(binaryPath); 
            console.log(`✅ ${BINARY_NAME} Downloaded.`);
            
            // IF LINUX: We must give it permission to execute
            if (!IS_WINDOWS) {
                fs.chmodSync(binaryPath, '755');
                console.log('✅ Permissions set for Linux binary.');
            }
        } catch (err) {
            console.error('❌ Failed to download binary:', err);
        }
    }
    ytDlpWrap = new YTDlpWrap(binaryPath);
};
ensureBinaryExists();

// --- QUEUE SYSTEM ---
class DownloadQueue {
    constructor(concurrency = 2) { 
        this.queue = [];
        this.activeCount = 0;
        this.concurrency = concurrency;
    }
    add(task) {
        this.queue.push(task);
        this.processNext();
        this.emitUpdate();
    }
    processNext() {
        if (this.activeCount >= this.concurrency || this.queue.length === 0) return;
        const task = this.queue.shift();
        this.activeCount++;
        this.emitUpdate();
        task().finally(() => {
            this.activeCount--;
            this.processNext();
            this.emitUpdate();
        });
    }
    emitUpdate() {
        io.to('admin_room').emit('queue_update', { length: this.queue.length, active: this.activeCount });
    }
}
const queue = new DownloadQueue(2);

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    const origin = socket.handshake.headers.origin;
    // Allow admin from localhost OR production domain
    if(origin && (origin.includes('3001') || origin.includes('admin.ankyy.com'))) {
        socket.join('admin_room'); 
    }
    emitStats();
});

const emitStats = async () => {
    try {
        const totalFiles = await FileModel.countDocuments();
        const totalViewsAgg = await BlogModel.aggregate([{ $group: { _id: null, total: { $sum: "$views" } } }]);
        const totalViews = totalViewsAgg[0]?.total || 0;
        const recent = await FileModel.find().sort({ date: -1 }).limit(10);
        
        let totalSizeMB = 0;
        const allFiles = await FileModel.find();
        allFiles.forEach(f => {
            totalSizeMB += parseFloat(f.size || 0);
        });

        io.to('admin_room').emit('stats_update', {
            totalFiles,
            storageUsage: totalSizeMB.toFixed(1),
            blogViews: totalViews,
            recentActivity: recent
        });
    } catch(e) {}
};

// ======================================================
// API ROUTES
// ======================================================

// Upload Image
app.post('/api/upload', upload.single('image'), (req, res) => {
    if(!req.file) return res.status(400).json({ success: false });
    // Return relative path so it works on both Local and Prod
    const imageUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, url: imageUrl });
});

// Save Blog Post
app.post('/api/blog', async (req, res) => {
    try {
        const { _id, title, content, slug, tags, excerpt, status, featuredImage } = req.body;
        let finalSlug = cleanSlug(slug || title);
        if (!finalSlug) finalSlug = `post-${Date.now()}`;

        let post;
        if (_id) {
            post = await BlogModel.findByIdAndUpdate(_id, {
                title, content, slug: finalSlug, tags, excerpt, status, featuredImage, date: new Date()
            }, { new: true });
        } else {
            post = new BlogModel({ title, content, slug: finalSlug, tags, excerpt, status, featuredImage });
            await post.save();
        }
        io.to('admin_room').emit('log', { message: `Post Saved: ${title}`, type: 'success' });
        emitStats();
        res.json({ success: true, data: post });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Get All Posts
app.get('/api/blog', async (req, res) => {
    try {
        const posts = await BlogModel.find().sort({ date: -1 });
        res.json({ success: true, data: posts });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Get Single Post
app.get('/api/blog/:slug', async (req, res) => {
    try {
        let post = await BlogModel.findOne({ slug: req.params.slug });
        if (!post) {
            const cleaned = cleanSlug(req.params.slug);
            post = await BlogModel.findOne({ slug: cleaned });
        }
        if(post) {
            post.views += 1;
            await post.save();
            res.json({ success: true, data: post });
        } else {
            res.status(404).json({ success: false });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

// Delete Post
app.delete('/api/blog/:id', async (req, res) => {
    try {
        await BlogModel.findByIdAndDelete(req.params.id);
        emitStats();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false }); }
});

// Get History
app.get('/api/history', async (req, res) => {
    try {
        let history = await FileModel.find().sort({ date: -1 });
        let totalSizeBytes = 0;
        history.forEach(record => {
             if(record.size) totalSizeBytes += (parseFloat(record.size) * 1024 * 1024);
        });
        const totalSizeMB = (totalSizeBytes / (1024 * 1024)).toFixed(1);
        res.json({ success: true, data: history, storage: totalSizeMB });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Get Playlist Meta
app.post('/api/playlist', async (req, res) => {
    if (!ytDlpWrap) return res.status(503).json({ success: false, message: "Initializing..." });
    const { url } = req.body;
    try {
        const metadataJSON = await ytDlpWrap.execPromise([url, '--flat-playlist', '--dump-single-json', '--no-warnings']);
        const playlistData = JSON.parse(metadataJSON);
        const entries = (playlistData.entries || []).map(entry => ({
            title: entry.title,
            url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
            id: entry.id
        }));
        res.json({ success: true, videos: entries, title: playlistData.title });
    } catch (error) { res.status(500).json({ success: false }); }
});

// CONVERT API
app.post('/api/convert', (req, res) => {
    if (!ytDlpWrap) return res.status(503).json({ success: false, message: "Initializing..." });
    const { url, type, quality = 'max', effect = 'none' } = req.body;
    
    const downloadTask = async () => {
        const startTime = Date.now();
        try {
            console.log(`[Start] ${url}`);
            io.to('admin_room').emit('log', { message: `Started: ${url}`, type: 'info' });

            const metadataJSON = await ytDlpWrap.execPromise([url, '--dump-json', '--no-playlist', '--no-warnings']);
            const meta = JSON.parse(metadataJSON);
            const cleanTitle = meta.title.replace(/[^\w\s-]/gi, '') || "downloaded_video";
            
            let suffix = '';
            if (type === 'mp4') suffix += `-${quality}`;
            if (effect !== 'none') suffix += `-${effect}`; 
            
            const filename = `${cleanTitle}${suffix}.${type}`;
            const outputTemplate = path.join(downloadDir, `${cleanTitle}${suffix}.%(ext)s`);

            // COOKIES: If cookies.txt exists, use it
            let args = [url, '-o', outputTemplate, '--no-playlist', '--force-overwrites', '--ffmpeg-location', ffmpegPath, '--add-metadata', '--embed-thumbnail'];
            
            if (fs.existsSync(path.join(__dirname, 'cookies.txt'))) {
                args.push('--cookies', path.join(__dirname, 'cookies.txt'));
            }

            let audioFilters = [];
            if (effect === 'slowed') audioFilters.push("asetrate=44100*0.88,atempo=1.0,aecho=0.8:0.9:1000:0.3");
            else if (effect === 'nightcore') audioFilters.push("asetrate=44100*1.25,atempo=1.0");
            else if (effect === 'bassboost') audioFilters.push("bass=g=10:f=110:w=0.6");

            if (type === 'mp3') {
                args.push('-x', '--audio-format', 'mp3');
                if (audioFilters.length > 0) args.push('--postprocessor-args', `ffmpeg:-af "${audioFilters.join(',')}"`);
            } else {
                let formatString = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
                if(quality === '1080') formatString = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]';
                if(quality === '720') formatString = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]';
                if(quality === '360') formatString = 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]';
                
                args.push('-f', formatString, '--merge-output-format', 'mp4');
                if (audioFilters.length > 0) args.push('--postprocessor-args', `ffmpeg:-af "${audioFilters.join(',')}"`);
            }

            await ytDlpWrap.execPromise(args);
            
            const stats = fs.statSync(path.join(downloadDir, filename));
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);

            const record = {
                id: Date.now(), title: cleanTitle, filename: filename, type: type, quality: quality,
                effect: effect, thumbnail: meta.thumbnail, date: new Date(), size: sizeMB, status: 'Success', downloadDuration: duration
            };
            
            await new FileModel(record).save();
            io.to('admin_room').emit('log', { message: `Finished: ${cleanTitle}`, type: 'success' });
            emitStats();

            if (!res.headersSent) res.json({ success: true, data: record });

        } catch (error) {
            console.error(error);
            io.to('admin_room').emit('log', { message: `Failed: ${url}`, type: 'error' });
            if (!res.headersSent) res.status(500).json({ success: false, message: "Failed" });
        }
    };
    queue.add(downloadTask);
});

// Delete File
app.delete('/api/files/:id', async (req, res) => {
    try {
        const fileRecord = await FileModel.findOne({ id: parseInt(req.params.id) });
        if (!fileRecord) return res.status(404).json({ success: false });

        const filePath = path.join(downloadDir, fileRecord.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        
        await FileModel.deleteOne({ id: parseInt(req.params.id) });
        emitStats();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// Zip Download
app.post('/api/zip', async (req, res) => {
    const { fileIds } = req.body;
    const filesToZip = await FileModel.find({ id: { $in: fileIds } });
    if(filesToZip.length === 0) return res.status(400).json({success: false});
    
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment('Ankyy_MusicBox.zip');
    archive.pipe(res);
    
    filesToZip.forEach(file => {
        const filePath = path.join(downloadDir, file.filename);
        if(fs.existsSync(filePath)) archive.file(filePath, { name: file.filename });
    });
    archive.finalize();
});

server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));