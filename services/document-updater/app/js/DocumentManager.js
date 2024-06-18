const { callbackifyAll } = require('@overleaf/promise-utils')
const RedisManager = require('./RedisManager')
const ProjectHistoryRedisManager = require('./ProjectHistoryRedisManager')
const PersistenceManager = require('./PersistenceManager')
const DiffCodec = require('./DiffCodec')
const logger = require('@overleaf/logger')
const Metrics = require('./Metrics')
const HistoryManager = require('./HistoryManager')
const Errors = require('./Errors')
const RangesManager = require('./RangesManager')
const { extractOriginOrSource } = require('./Utils')

const MAX_UNFLUSHED_AGE = 300 * 1000 // 5 mins, document should be flushed to mongo this time after a change

const DocumentManager = {
  async getDoc(projectId, docId) {
    const {
      lines,
      version,
      ranges,
      resolvedCommentIds,
      pathname,
      projectHistoryId,
      unflushedTime,
      historyRangesSupport,
    } = await RedisManager.promises.getDoc(projectId, docId)
    if (lines == null || version == null) {
      logger.debug(
        { projectId, docId },
        'doc not in redis so getting from persistence API'
      )
      const {
        lines,
        version,
        ranges,
        resolvedCommentIds,
        pathname,
        projectHistoryId,
        historyRangesSupport,
      } = await PersistenceManager.promises.getDoc(projectId, docId)
      logger.debug(
        {
          projectId,
          docId,
          lines,
          ranges,
          resolvedCommentIds,
          version,
          pathname,
          projectHistoryId,
          historyRangesSupport,
        },
        'got doc from persistence API'
      )
      await RedisManager.promises.putDocInMemory(
        projectId,
        docId,
        lines,
        version,
        ranges,
        resolvedCommentIds,
        pathname,
        projectHistoryId,
        historyRangesSupport
      )
      return {
        lines,
        version,
        ranges: ranges || {},
        resolvedCommentIds,
        pathname,
        projectHistoryId,
        unflushedTime: null,
        alreadyLoaded: false,
        historyRangesSupport,
      }
    } else {
      return {
        lines,
        version,
        ranges,
        pathname,
        projectHistoryId,
        resolvedCommentIds,
        unflushedTime,
        alreadyLoaded: true,
        historyRangesSupport,
      }
    }
  },

  async getDocAndRecentOps(projectId, docId, fromVersion) {
    const { lines, version, ranges, pathname, projectHistoryId } =
      await DocumentManager.getDoc(projectId, docId)

    if (fromVersion === -1) {
      return { lines, version, ops: [], ranges, pathname, projectHistoryId }
    } else {
      const ops = await RedisManager.promises.getPreviousDocOps(
        docId,
        fromVersion,
        version
      )
      return {
        lines,
        version,
        ops,
        ranges,
        pathname,
        projectHistoryId,
      }
    }
  },

  async setDoc(projectId, docId, newLines, originOrSource, userId, undoing) {
    if (newLines == null) {
      throw new Error('No lines were provided to setDoc')
    }

    const UpdateManager = require('./UpdateManager')
    const {
      lines: oldLines,
      version,
      alreadyLoaded,
    } = await DocumentManager.getDoc(projectId, docId)

    if (oldLines != null && oldLines.length > 0 && oldLines[0].text != null) {
      logger.debug(
        { docId, projectId, oldLines, newLines },
        'document is JSON so not updating'
      )
      return
    }

    logger.debug(
      { docId, projectId, oldLines, newLines },
      'setting a document via http'
    )
    const op = DiffCodec.diffAsShareJsOp(oldLines, newLines)
    if (undoing) {
      for (const o of op || []) {
        o.u = true
      } // Turn on undo flag for each op for track changes
    }

    const { origin, source } = extractOriginOrSource(originOrSource)

    const update = {
      doc: docId,
      op,
      v: version,
      meta: {
        type: 'external',
        user_id: userId,
      },
    }
    if (origin) {
      update.meta.origin = origin
    } else if (source) {
      update.meta.source = source
    }
    // Keep track of external updates, whether they are for live documents
    // (flush) or unloaded documents (evict), and whether the update is a no-op.
    Metrics.inc('external-update', 1, {
      status: op.length > 0 ? 'diff' : 'noop',
      method: alreadyLoaded ? 'flush' : 'evict',
      path: source,
    })

    // Do not notify the frontend about a noop update.
    // We still want to execute the code below
    // to evict the doc if we loaded it into redis for
    // this update, otherwise the doc would never be
    // removed from redis.
    if (op.length > 0) {
      await UpdateManager.promises.applyUpdate(projectId, docId, update)
    }

    // If the document was loaded already, then someone has it open
    // in a project, and the usual flushing mechanism will happen.
    // Otherwise we should remove it immediately since nothing else
    // is using it.
    if (alreadyLoaded) {
      return await DocumentManager.flushDocIfLoaded(projectId, docId)
    } else {
      try {
        return await DocumentManager.flushAndDeleteDoc(projectId, docId, {})
      } finally {
        // There is no harm in flushing project history if the previous
        // call failed and sometimes it is required
        HistoryManager.flushProjectChangesAsync(projectId)
      }
    }
  },

  async flushDocIfLoaded(projectId, docId) {
    const {
      lines,
      version,
      ranges,
      unflushedTime,
      lastUpdatedAt,
      lastUpdatedBy,
    } = await RedisManager.promises.getDoc(projectId, docId)
    if (lines == null || version == null) {
      Metrics.inc('flush-doc-if-loaded', 1, { status: 'not-loaded' })
      logger.debug({ projectId, docId }, 'doc is not loaded so not flushing')
      // TODO: return a flag to bail out, as we go on to remove doc from memory?
      return
    } else if (unflushedTime == null) {
      Metrics.inc('flush-doc-if-loaded', 1, { status: 'unmodified' })
      logger.debug({ projectId, docId }, 'doc is not modified so not flushing')
      return
    }

    logger.debug({ projectId, docId, version }, 'flushing doc')
    Metrics.inc('flush-doc-if-loaded', 1, { status: 'modified' })
    const result = await PersistenceManager.promises.setDoc(
      projectId,
      docId,
      lines,
      version,
      ranges,
      lastUpdatedAt,
      lastUpdatedBy || null
    )
    await RedisManager.promises.clearUnflushedTime(docId)
    return result
  },

  async flushAndDeleteDoc(projectId, docId, options) {
    let result
    try {
      result = await DocumentManager.flushDocIfLoaded(projectId, docId)
    } catch (error) {
      if (options.ignoreFlushErrors) {
        logger.warn(
          { projectId, docId, err: error },
          'ignoring flush error while deleting document'
        )
      } else {
        throw error
      }
    }

    await RedisManager.promises.removeDocFromMemory(projectId, docId)
    return result
  },

  async acceptChanges(projectId, docId, changeIds) {
    if (changeIds == null) {
      changeIds = []
    }

    const {
      lines,
      version,
      ranges,
      pathname,
      projectHistoryId,
      historyRangesSupport,
    } = await DocumentManager.getDoc(projectId, docId)
    if (lines == null || version == null) {
      throw new Errors.NotFoundError(`document not found: ${docId}`)
    }

    const newRanges = RangesManager.acceptChanges(changeIds, ranges)

    await RedisManager.promises.updateDocument(
      projectId,
      docId,
      lines,
      version,
      [],
      newRanges,
      {}
    )

    if (historyRangesSupport) {
      const historyUpdates = RangesManager.getHistoryUpdatesForAcceptedChanges({
        docId,
        acceptedChangeIds: changeIds,
        changes: ranges.changes || [],
        lines,
        pathname,
        projectHistoryId,
      })

      if (historyUpdates.length === 0) {
        return
      }

      await ProjectHistoryRedisManager.promises.queueOps(
        projectId,
        ...historyUpdates.map(op => JSON.stringify(op))
      )
    }
  },

  async updateCommentState(projectId, docId, commentId, userId, resolved) {
    const { lines, version, pathname, historyRangesSupport } =
      await DocumentManager.getDoc(projectId, docId)

    if (lines == null || version == null) {
      throw new Errors.NotFoundError(`document not found: ${docId}`)
    }

    if (historyRangesSupport) {
      await RedisManager.promises.updateCommentState(docId, commentId, resolved)

      await ProjectHistoryRedisManager.promises.queueOps(
        projectId,
        JSON.stringify({
          pathname,
          commentId,
          resolved,
          meta: {
            ts: new Date(),
            user_id: userId,
          },
        })
      )
    }
  },

  async deleteComment(projectId, docId, commentId, userId) {
    const { lines, version, ranges, pathname, historyRangesSupport } =
      await DocumentManager.getDoc(projectId, docId)
    if (lines == null || version == null) {
      throw new Errors.NotFoundError(`document not found: ${docId}`)
    }

    const newRanges = RangesManager.deleteComment(commentId, ranges)

    await RedisManager.promises.updateDocument(
      projectId,
      docId,
      lines,
      version,
      [],
      newRanges,
      {}
    )

    if (historyRangesSupport) {
      await RedisManager.promises.updateCommentState(docId, commentId, false)
      await ProjectHistoryRedisManager.promises.queueOps(
        projectId,
        JSON.stringify({
          pathname,
          deleteComment: commentId,
          meta: {
            ts: new Date(),
            user_id: userId,
          },
        })
      )
    }
  },

  async renameDoc(projectId, docId, userId, update, projectHistoryId) {
    await RedisManager.promises.renameDoc(
      projectId,
      docId,
      userId,
      update,
      projectHistoryId
    )
  },

  async getDocAndFlushIfOld(projectId, docId) {
    const { lines, version, unflushedTime, alreadyLoaded } =
      await DocumentManager.getDoc(projectId, docId)

    // if doc was already loaded see if it needs to be flushed
    if (
      alreadyLoaded &&
      unflushedTime != null &&
      Date.now() - unflushedTime > MAX_UNFLUSHED_AGE
    ) {
      await DocumentManager.flushDocIfLoaded(projectId, docId)
    }

    return { lines, version }
  },

  async resyncDocContents(projectId, docId, path, opts = {}) {
    logger.debug({ projectId, docId, path }, 'start resyncing doc contents')
    let {
      lines,
      ranges,
      resolvedCommentIds,
      version,
      projectHistoryId,
      historyRangesSupport,
    } = await RedisManager.promises.getDoc(projectId, docId)

    // To avoid issues where the same docId appears with different paths,
    // we use the path from the resyncProjectStructure update.  If we used
    // the path from the getDoc call to web then the two occurences of the
    // docId would map to the same path, and this would be rejected by
    // project-history as an unexpected resyncDocContent update.
    if (lines == null || version == null) {
      logger.debug(
        { projectId, docId },
        'resyncing doc contents - not found in redis - retrieving from web'
      )
      ;({
        lines,
        ranges,
        resolvedCommentIds,
        version,
        projectHistoryId,
        historyRangesSupport,
      } = await PersistenceManager.promises.getDoc(projectId, docId, {
        peek: true,
      }))
    } else {
      logger.debug(
        { projectId, docId },
        'resyncing doc contents - doc in redis - will queue in redis'
      )
    }

    if (opts.historyRangesMigration) {
      historyRangesSupport = opts.historyRangesMigration === 'forwards'
    }

    await ProjectHistoryRedisManager.promises.queueResyncDocContent(
      projectId,
      projectHistoryId,
      docId,
      lines,
      ranges,
      resolvedCommentIds,
      version,
      // use the path from the resyncProjectStructure update
      path,
      historyRangesSupport
    )

    if (opts.historyRangesMigration) {
      await RedisManager.promises.setHistoryRangesSupportFlag(
        docId,
        historyRangesSupport
      )
    }
  },

  async getDocWithLock(projectId, docId) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.getDoc,
      projectId,
      docId
    )
  },

  async getDocAndRecentOpsWithLock(projectId, docId, fromVersion) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.getDocAndRecentOps,
      projectId,
      docId,
      fromVersion
    )
  },

  async getDocAndFlushIfOldWithLock(projectId, docId) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.getDocAndFlushIfOld,
      projectId,
      docId
    )
  },

  async setDocWithLock(projectId, docId, lines, source, userId, undoing) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.setDoc,
      projectId,
      docId,
      lines,
      source,
      userId,
      undoing
    )
  },

  async flushDocIfLoadedWithLock(projectId, docId) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.flushDocIfLoaded,
      projectId,
      docId
    )
  },

  async flushAndDeleteDocWithLock(projectId, docId, options) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.flushAndDeleteDoc,
      projectId,
      docId,
      options
    )
  },

  async acceptChangesWithLock(projectId, docId, changeIds) {
    const UpdateManager = require('./UpdateManager')
    await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.acceptChanges,
      projectId,
      docId,
      changeIds
    )
  },

  async updateCommentStateWithLock(
    projectId,
    docId,
    threadId,
    userId,
    resolved
  ) {
    const UpdateManager = require('./UpdateManager')
    await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.updateCommentState,
      projectId,
      docId,
      threadId,
      userId,
      resolved
    )
  },

  async deleteCommentWithLock(projectId, docId, threadId, userId) {
    const UpdateManager = require('./UpdateManager')
    await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.deleteComment,
      projectId,
      docId,
      threadId,
      userId
    )
  },

  async renameDocWithLock(projectId, docId, userId, update, projectHistoryId) {
    const UpdateManager = require('./UpdateManager')
    await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.renameDoc,
      projectId,
      docId,
      userId,
      update,
      projectHistoryId
    )
  },

  async resyncDocContentsWithLock(projectId, docId, path, opts) {
    const UpdateManager = require('./UpdateManager')
    await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.resyncDocContents,
      projectId,
      docId,
      path,
      opts
    )
  },
}

module.exports = {
  ...callbackifyAll(DocumentManager, {
    multiResult: {
      getDoc: [
        'lines',
        'version',
        'ranges',
        'pathname',
        'projectHistoryId',
        'unflushedTime',
        'alreadyLoaded',
        'historyRangesSupport',
      ],
      getDocWithLock: [
        'lines',
        'version',
        'ranges',
        'pathname',
        'projectHistoryId',
        'unflushedTime',
        'alreadyLoaded',
        'historyRangesSupport',
      ],
      getDocAndFlushIfOld: ['lines', 'version'],
      getDocAndFlushIfOldWithLock: ['lines', 'version'],
      getDocAndRecentOps: [
        'lines',
        'version',
        'ops',
        'ranges',
        'pathname',
        'projectHistoryId',
      ],
      getDocAndRecentOpsWithLock: [
        'lines',
        'version',
        'ops',
        'ranges',
        'pathname',
        'projectHistoryId',
      ],
    },
  }),
  promises: DocumentManager,
}
