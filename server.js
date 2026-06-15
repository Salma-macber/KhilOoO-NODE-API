const cors = require('cors');
const express = require('express');
const fs = require('fs/promises');
const multer = require('multer');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

function isReadOnlyDeployRoot() {
  return __dirname.startsWith('/var/task');
}

const RUNTIME_ROOT = path.join(os.tmpdir(), 'filters-api');
const BUNDLED_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = isReadOnlyDeployRoot()
  ? path.join(RUNTIME_ROOT, 'data')
  : BUNDLED_DATA_DIR;
const UPLOADS_DIR = isReadOnlyDeployRoot()
  ? path.join(RUNTIME_ROOT, 'uploads')
  : path.join(__dirname, 'uploads');
const FILTERS_FILE = path.join(DATA_DIR, 'filters.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const BUNDLED_FILTERS_FILE = path.join(BUNDLED_DATA_DIR, 'filters.json');

let dirsReady;

async function ensureRuntimeDirs() {
  if (!dirsReady) {
    dirsReady = (async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.mkdir(UPLOADS_DIR, { recursive: true });

      if (isReadOnlyDeployRoot()) {
        try {
          await fs.access(FILTERS_FILE);
        } catch {
          await fs.copyFile(BUNDLED_FILTERS_FILE, FILTERS_FILE);
        }
      }
    })();
  }

  return dirsReady;
}

function buildUploadFilename(file) {
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const ext = path.extname(file.originalname) || '.jpg';
  return `${file.fieldname}-${unique}${ext}`;
}

let uploadFilter;

function getUploadFilter() {
  if (uploadFilter) {
    return uploadFilter;
  }

  uploadFilter = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
  }).fields([
    { name: 'before_image', maxCount: 1 },
    { name: 'after_image', maxCount: 1 },
    { name: 'dngfile', maxCount: 1 },
  ]);

  return uploadFilter;
}

async function persistUploadedFile(file) {
  await ensureRuntimeDirs();
  const filename = buildUploadFilename(file);
  const filePath = path.join(UPLOADS_DIR, filename);
  await fs.writeFile(filePath, file.buffer);
  return { filename, path: filePath };
}

const app = express();

app.set('trust proxy', 1);

app.use(
  cors({
    origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()),
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Accept', 'Content-Type', 'X-Requested-With'],
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(async (_req, _res, next) => {
  try {
    await ensureRuntimeDirs();
    next();
  } catch (error) {
    next(error);
  }
});

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
    entries.map((file) => {
      if (!file.path) {
        return undefined;
      }
      return fs.unlink(file.path).catch(() => undefined);
    }),
  );
}

function localUploadFilename(url) {
  if (typeof url !== 'string') {
    return null;
  }

  const marker = '/uploads/';
  const index = url.indexOf(marker);
  if (index === -1) {
    return null;
  }

  return path.basename(url.slice(index + marker.length));
}

async function deleteLocalUploadFiles(filters) {
  const filenames = new Set();

  for (const filter of filters) {
    for (const key of ['before_image', 'after_image', 'dngfile']) {
      const filename = localUploadFilename(filter[key]);
      if (filename) {
        filenames.add(filename);
      }
    }
  }

  await Promise.all(
    [...filenames].map((filename) =>
      fs.unlink(path.join(UPLOADS_DIR, filename)).catch(() => undefined),
    ),
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
  getUploadFilter()(req, res, async (error) => {
    if (error) {
      await removeUploadedFiles(req.files);
      return res.status(422).json({
        message: error.code === 'LIMIT_FILE_SIZE' ? 'File too large' : 'Invalid upload',
      });
    }

    try {
      let beforeImage = req.files?.before_image?.[0];
      let afterImage = req.files?.after_image?.[0];
      let dngFile = req.files?.dngfile?.[0];

      if (!beforeImage || !afterImage || !dngFile) {
        return res.status(422).json({
          message: 'before_image, after_image, and dngfile are required',
        });
      }

      beforeImage = await persistUploadedFile(beforeImage);
      afterImage = await persistUploadedFile(afterImage);
      dngFile = await persistUploadedFile(dngFile);

      const downloadCount = Number(req.body.download_count ?? 0);
      if (!Number.isFinite(downloadCount)) {
        await removeUploadedFiles({ files: [beforeImage, afterImage, dngFile] });
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

// POST /api/deleteFilter/:id  (Laravel-style _method=delete from Flutter)
app.post('/api/deleteFilter/:id', async (req, res, next) => {
  try {
    const filterId = Number(req.params.id);

    if (!Number.isFinite(filterId)) {
      return res.status(422).json({ message: 'Invalid filter id' });
    }

    const filters = await loadFilters();
    const index = filters.findIndex((item) => item.id === filterId);

    if (index === -1) {
      return res.status(404).json({ message: 'Filter not found' });
    }

    const [removed] = filters.splice(index, 1);
    await deleteLocalUploadFiles([removed]);
    await saveFilters(filters);

    res.json({
      message: 'Filter deleted successfully',
      data: removed,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/removeAllFilters
app.post('/api/removeAllFilters', async (_req, res, next) => {
  try {
    const filters = await loadFilters();
    const removedCount = filters.length;

    await deleteLocalUploadFiles(filters);
    await saveFilters([]);

    res.json({
      message: 'All filters removed',
      removed_count: removedCount,
    });
  } catch (error) {
    next(error);
  }
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

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

app.use('/uploads', express.static(UPLOADS_DIR));

app.use((_req, res) => {
  res.status(404).json({ message: 'Not found' });
});

app.use((error, _req, res, _next) => {
  console.error('[API]', error);
  res.status(500).json({ message: 'Internal server error' });
});

module.exports = app;

if (require.main === module) {
  ensureRuntimeDirs()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Filters API listening on http://localhost:${PORT}/api/`);
        console.log(
          'Endpoints: getAllFilters, getMostDownloadFilters, updateDownloadCount/:id, uploadNewFilter, deleteFilter/:id, removeAllFilters, storeDevice',
        );
      });
    })
    .catch((error) => {
      console.error('[API] Failed to start server', error);
      process.exit(1);
    });
}
