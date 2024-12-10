import fs from "fs"
import os from "node:os"
import { join, dirname, basename } from "path"
import { app, ipcMain, dialog } from "electron"
import * as jetpack from "fs-jetpack";

import CONFIG from "../config"
import { isDev } from "../detect-platform"
import { win } from "./index"
import { eraseInitialContent, initialContent, initialDevContent } from '../initial-content'

const untildify = (pathWithTilde) => {
    const homeDirectory = os.homedir();
    return homeDirectory
      ? pathWithTilde.replace(/^~(?=$|\/|\\)/, homeDirectory)
      : pathWithTilde;
}

export function constructBufferFilePath(directoryPath, suffix) {
    return join(untildify(directoryPath), isDev ? `buffer-dev-${suffix}.txt` : `buffer-${suffix}.txt`)
}

export function getBufferFilePath(suffix) {
    let defaultPath = app.getPath("userData")
    let configPath = CONFIG.get("settings.bufferPath")
    let bufferPath = configPath.length ? configPath : defaultPath
    let bufferFilePath = constructBufferFilePath(bufferPath, suffix)
    try {
        // use realpathSync to resolve a potential symlink
        return fs.realpathSync(bufferFilePath)
    } catch (err) {
        // realpathSync will fail if the file does not exist, but that doesn't matter since the file will be created
        if (err.code !== "ENOENT") {
            throw err
        }
        return bufferFilePath
    }
}


export class Buffer {
    constructor({name, filePath, onChange}) {
        this.name = name
        this.filePath = filePath
        this.onChange = onChange
        this.watcher = null
        this.setupWatcher()
        this._lastSavedContent = null
    }

    async load() {
        const content = await jetpack.read(this.filePath, 'utf8')
        this.setupWatcher()
        return [this.name, content]
    }

    async save(content) {
        this._lastSavedContent = content
        const saveResult = await jetpack.write(this.filePath, content, {
            atomic: true,
            mode: '600',
        })
        return saveResult
    }

    exists() {
        return jetpack.exists(this.filePath) === "file"
    }

    setupWatcher() {
        if (!this.watcher && this.exists()) {
            this.watcher = fs.watch(
                dirname(this.filePath), 
                {
                    persistent: true,
                    recursive: false,
                    encoding: "utf8",
                },
                async (eventType, filename) => {
                    if (filename !== basename(this.filePath)) {
                        return
                    }
                    
                    // read the file content and compare it to the last saved content
                    // (if the content is the same, then we can ignore the event)
                    const content = await jetpack.read(this.filePath, 'utf8')

                    if (this._lastSavedContent !== content) {
                        // file has changed on disk, trigger onChange
                        this.onChange(content)
                    }
                }
            )
        }
    }

    close() {
        if (this.watcher) {
            this.watcher.close()
            this.watcher = null
        }
    }
}


// Buffer
let buffers = {}
export function loadBuffer(suffix) {
    let buffer = new Buffer({
        name: suffix,
        filePath: getBufferFilePath(suffix),
        onChange: (content) => {
            win?.webContents.send("buffer-content:change", suffix, content)
        },
    })
    return buffer
}

export function loadBuffers() {
    if (Object.keys(buffers).length > 0)
    {
        for (let bufferName in buffers)
        {
            buffers[bufferName].close()
        }
    }
    let buffersToLoad = CONFIG.get('buffers')
    buffersToLoad.forEach(suffix => {
        buffers[suffix] = loadBuffer(suffix)
    })

    return buffers
}

async function loadBufferIfExists(bufferName)
{
    if (buffers[bufferName].exists() && !(eraseInitialContent && isDev)) {
        return await buffers[bufferName].load()
    } else {
        let content = isDev ? initialDevContent : initialContent
        return [bufferName, content]
    }
}

ipcMain.handle('buffer-content:load', async (event, bufferName) => {
    return await loadBufferIfExists(bufferName)
});

async function save(bufferName, content) {
    return await buffers[bufferName].save(content)
}

ipcMain.handle('buffer-content:save', async (event, bufferName, content) => {
    return await save(bufferName, content)
});

export let contentSaved = false
ipcMain.handle('buffer-content:saveAndQuit', async (event, bufferName, content) => {
    await save(bufferName, content)
    contentSaved = true
    app.quit()
})

ipcMain.handle("buffer-content:selectLocation", async () => {
    let result = await dialog.showOpenDialog({
        title: "Select directory to store buffer",
        properties: [
            "openDirectory",
            "createDirectory",
            "noResolveAliases",
        ],
    })
    if (result.canceled) {
        return
    }
    const filePath = result.filePaths[0]
    if (fs.existsSync(constructBufferFilePath(filePath, '0'))) {
        if (dialog.showMessageBoxSync({
            type: "question",
            message: "The selected directory already contains a buffer file. It will be loaded. Do you want to continue?",
            buttons: ["Cancel", "Continue"],
        }) === 0) {
            return
        }
    }
    return filePath
})

ipcMain.handle('buffer-content:all', async () => {
    return await Promise.all(Object.entries(buffers).map(async ([_, b]) => await b.load()))
})

ipcMain.handle('multibuffer:new', async (event, bufferName) => {
    if (bufferName in buffers)
    {
        buffers[bufferName].close()
    }
    buffers[bufferName] = loadBuffer(bufferName)

    let content = await loadBufferIfExists(bufferName)

    buffers[bufferName].onChange(content[1])
})