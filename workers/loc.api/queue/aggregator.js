'use strict'

const { promisify } = require('util')
const fs = require('fs')

const unlink = promisify(fs.unlink)

const {
  getEmail,
  uploadS3,
  sendMail,
  checkS3SendgridCoreUser,
  moveFileToLocalStorage
} = require('./helpers')

let reportService = null

module.exports = async job => {
  const aggregatorQueue = reportService.ctx.lokue_aggregator.q

  try {
    const data = job.data
    const filePath = data.filePath
    const name = data.name
    const isUnauth = job.data.isUnauth || false
    const token = job.data.token || false

    if (token) await checkS3SendgridCoreUser(reportService)
    const email = token && await getEmail(reportService, { token })

    if (email) {
      const s3Data = await uploadS3(reportService, data.s3Conf, filePath, name)
      s3Data.isUnauth = isUnauth
      await sendMail(reportService, data.emailConf, data.email, 'email.pug', s3Data)
      await unlink(data.filePath)
    } else {
      await moveFileToLocalStorage(filePath, name, data.startDate, data.endDate)
    }

    job.done()
    aggregatorQueue.emit('completed')
  } catch (err) {
    if (err.syscall === 'unlink') {
      job.done()
      aggregatorQueue.emit('error:unlink', job)
    }

    job.done(err)
    aggregatorQueue.emit('error:base', job)
  }
}

module.exports.setReportService = (rService) => {
  reportService = rService
}
