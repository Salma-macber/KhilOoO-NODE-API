const cors = require('cors');
const express = require('express');
const fs = require('fs/promises');
const multer = require('multer');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const FILTERS_FILE = path.join(DATA_DIR, 'filters.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

const uploadFilter = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${file.fieldname}-${unique}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
}).fields([
  { name: 'before_image', maxCount: 1 },
  { name: 'after_image', maxCount: 1 },
  { name: 'dngfile', maxCount: 1 },
]);

const app = express();

app.use(
  cors({
    origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()),
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Accept', 'Content-Type', 'X-Requested-With'],
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function loadFilters() {
  const body = await readJson(FILTERS_FILE, { data: [] });
  return Array.isArray(body.data) ? body.data : [];
}

async function saveFilters(filters) {
  await writeJson(FILTERS_FILE, { data: filters });
}

function mostDownloaded(filters) {
  return [...filters].sort((a, b) => b.download_count - a.download_count);
}

function nextFilterId(filters) {
  return filters.reduce((max, item) => Math.max(max, item.id || 0), 0) + 1;
}

function uploadedFileUrl(req, filename) {
  return `${req.protocol}://${req.get('host')}/uploads/${filename}`;
}

async function removeUploadedFiles(files) {
  if (!files) {
    return;
  }

  const entries = Object.values(files).flat();
  await Promise.all(
    entries.map((file) => fs.unlink(file.path).catch(() => undefined)),
  );
}

// GET /api/getAllFilters
app.get('/api/getAllFilters', async (_req, res, next) => {
  try {
    const filters = await loadFilters();
    res.json({ data: filters });
  } catch (error) {
    next(error);
  }
});

// GET /api/getMostDownloadFilters
app.get('/api/getMostDownloadFilters', async (_req, res, next) => {
  try {
    const filters = await loadFilters();
    res.json({ data: mostDownloaded(filters) });
  } catch (error) {
    next(error);
  }
});

// POST /api/updateDownloadCount/:id  (Laravel-style _method=put from Flutter)
app.post('/api/updateDownloadCount/:id', async (req, res, next) => {
  try {
    const filterId = Number(req.params.id);
    const downloadCount = Number(req.body.download_count);

    if (!Number.isFinite(filterId) || !Number.isFinite(downloadCount)) {
      return res.status(422).json({
        message: 'Invalid filter id or download_count',
      });
    }

    const filters = await loadFilters();
    const index = filters.findIndex((item) => item.id === filterId);

    if (index === -1) {
      return res.status(404).json({ message: 'Filter not found' });
    }

    filters[index].download_count = downloadCount;
    await saveFilters(filters);

    res.json({
      message: 'Download count updated',
      data: filters[index],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/uploadNewFilter
app.post('/api/uploadNewFilter', (req, res, next) => {
  uploadFilter(req, res, async (error) => {
    if (error) {
      await removeUploadedFiles(req.files);
      return res.status(422).json({
        message: error.code === 'LIMIT_FILE_SIZE' ? 'File too large' : 'Invalid upload',
      });
    }

    try {
      const beforeImage = req.files?.before_image?.[0];
      const afterImage = req.files?.after_image?.[0];
      const dngFile = req.files?.dngfile?.[0];

      if (!beforeImage || !afterImage || !dngFile) {
        await removeUploadedFiles(req.files);
        return res.status(422).json({
          message: 'before_image, after_image, and dngfile are required',
        });
      }

      const downloadCount = Number(req.body.download_count ?? 0);
      if (!Number.isFinite(downloadCount)) {
        await removeUploadedFiles(req.files);
        return res.status(422).json({ message: 'Invalid download_count' });
      }

      const filters = await loadFilters();
      const filter = {
        id: nextFilterId(filters),
        before_image: uploadedFileUrl(req, beforeImage.filename),
        after_image: uploadedFileUrl(req, afterImage.filename),
        dngfile: uploadedFileUrl(req, dngFile.filename),
        download_count: downloadCount,
      };

      filters.push(filter);
      await saveFilters(filters);

      res.status(201).json({
        message: 'Filter uploaded successfully',
        data: filter,
      });
    } catch (handlerError) {
      await removeUploadedFiles(req.files);
      next(handlerError);
    }
  });
});

// POST /api/storeDevice
app.post('/api/storeDevice', async (req, res, next) => {
  try {
    const { device_token: deviceToken, type } = req.body;

    if (!deviceToken || typeof deviceToken !== 'string') {
      return res.status(422).json({ message: 'device_token is required' });
    }

    const devices = await readJson(DEVICES_FILE, []);
    const existing = devices.find((entry) => entry.device_token === deviceToken);

    if (existing) {
      existing.type = type || existing.type;
      existing.updated_at = new Date().toISOString();
    } else {
      devices.push({
        device_token: deviceToken,
        type: type || 'android',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    await writeJson(DEVICES_FILE, devices);

    res.status(existing ? 200 : 201).json({
      message: existing ? 'Device updated' : 'Device stored',
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/uploads', express.static(UPLOADS_DIR));

app.use((_req, res) => {
  res.status(404).json({ message: 'Not found' });
});

app.use((error, _req, res, _next) => {
  console.error('[API]', error);
  res.status(500).json({ message: 'Internal server error' });
});

async function startServer() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });

  app.listen(PORT, () => {
    console.log(`Filters API listening on http://localhost:${PORT}/api/`);
    console.log(
      'Endpoints: getAllFilters, getMostDownloadFilters, updateDownloadCount/:id, uploadNewFilter, storeDevice',
    );
  });
}

startServer().catch((error) => {
  console.error('[API] Failed to start server', error);
  process.exit(1);
});
