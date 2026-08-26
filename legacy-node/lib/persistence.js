const fs = require("fs");
const path = require("path");

async function atomicWriteFile(filePath, contents, encoding = "utf8") {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fs.promises.writeFile(temporaryPath, contents, encoding);
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function readJsonFile(filePath, fallback, logger = console, database = null) {
  if (database) return database.readDocument(filePath, fallback);
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    logger.error(`[persistence] Unable to read ${path.basename(filePath)}`, error);
    return fallback;
  }
}

function createDebouncedWriter({ write, delayMs = 100, label = "persistence", logger = console }) {
  let timer = null;
  let dirty = false;
  let chain = Promise.resolve();

  function commit() {
    if (!dirty) return chain;
    dirty = false;
    chain = chain.then(write).catch((error) => logger.error(`[${label}] Unable to save data`, error));
    return chain;
  }

  function schedule() {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      commit();
    }, delayMs);
  }

  async function flush() {
    clearTimeout(timer);
    timer = null;
    await commit();
    await chain;
  }

  return { schedule, flush };
}

function createJsonStore({ filePath, getData, delayMs, label, logger = console, database = null }) {
  return createDebouncedWriter({
    delayMs,
    label,
    logger,
    write: async () => {
      const data = getData();
      if (database) database.writeDocument(filePath, data);
      await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
    },
  });
}

module.exports = { atomicWriteFile, createDebouncedWriter, createJsonStore, readJsonFile };
