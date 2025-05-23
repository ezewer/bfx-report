'use strict'

const { Transform } = require('stream')
const path = require('path')
const fs = require('fs')
const pug = require('pug')

const getCompleteFileName = require('../../queue/helpers/get-complete-file-name')
const getTranslator = require('../../helpers/get-translator')
const {
  getDateNotLessMinStart
} = require('../../helpers/date-param.helpers')
const {
  GrcPDFAvailabilityError
} = require('../../errors')
const TEMPLATE_FILE_NAMES = require('./template-file-names')
const TRANSLATION_NAMESPACES = require(
  '../../i18next/translation.namespaces'
)

const placeholderPattern = /\$\{[a-zA-Z0-9]+\}/g
const pathToFonts = path.join(__dirname, 'templates/fonts')
const fontsTemplate = fs
  .readFileSync(path.join(pathToFonts, 'fonts.css'), 'utf8')
const base64Fonts = {
  interRegular: fs
    .readFileSync(path.join(pathToFonts, 'Inter-Regular.ttf'), 'base64')
}

const { decorateInjectable } = require('../../di/utils')

const depsTypes = (TYPES) => [
  TYPES.ROOT_FOLDER_PATH,
  TYPES.HasGrcService,
  TYPES.GrcBfxReq,
  TYPES.I18next
]
class PdfWriter {
  #fonts = this.#renderFontsTemplate(fontsTemplate, base64Fonts)
  #templatePaths = new Map()
  #templates = new Map()

  constructor (
    rootFolderPath,
    hasGrcService,
    grcBfxReq,
    i18next
  ) {
    this.rootFolderPath = rootFolderPath
    this.hasGrcService = hasGrcService
    this.grcBfxReq = grcBfxReq
    this.i18next = i18next

    this.isElectronjsEnv = false
    this.shouldZoomBeAdjusted = (
      process.platform !== 'win32' &&
      !this.isElectronjsEnv
    )

    this.addTemplates()
    this.compileTemplate()
  }

  async createPDFStream (opts) {
    const pdfWriter = this

    return new Transform({
      writableObjectMode: true,

      construct (cb) {
        this.data = []
        cb()
      },
      transform (chunk, encoding, cb) {
        if (Array.isArray(chunk)) {
          this.data.push(...chunk)
          cb()

          return
        }

        this.data.push(chunk)
        cb()
      },
      flush (cb) {
        pdfWriter.#processPdf(
          this.data,
          opts
        ).then((buffer) => {
          this.push(buffer)
          this.push(null)
          cb()
        }).catch((err) => {
          cb(err)
        })
      }
    })
  }

  async #processPdf (
    apiData,
    opts
  ) {
    const template = await this.#renderTemplate(
      apiData,
      opts
    )
    const buffer = await this.createPDFBuffer({
      template,
      language: opts?.language
    })

    return buffer
  }

  async createPDFBuffer (args) {
    const _args = {
      template: 'No data',
      format: 'portrait',
      orientation: 'Letter',
      headerHeight: '65mm',
      footerHeight: '28mm',
      ...args
    }

    if (!await this.hasGrcService.hasPDFService()) {
      throw new GrcPDFAvailabilityError()
    }

    const bufferData = await this.grcBfxReq({
      service: 'rest:ext:pdf',
      action: 'createPDFBuffer',
      args: [_args]
    })
    const res = Buffer.from(bufferData)

    return res
  }

  #getTemplate (pdfCustomTemplateName, language) {
    const templateKey = this.#getTemplateKey(
      pdfCustomTemplateName ?? TEMPLATE_FILE_NAMES.MAIN,
      language
    )

    if (this.#templates.has(templateKey)) {
      return this.#templates.get(templateKey)
    }

    return this.#templates.get(this.#getTemplateKey(
      TEMPLATE_FILE_NAMES.MAIN,
      'en'
    ))
  }

  async #renderTemplate (
    apiData,
    opts
  ) {
    const {
      jobData,
      pdfCustomTemplateName,
      language = 'en',
      isError
    } = opts ?? {}

    const template = this.#getTemplate(
      pdfCustomTemplateName,
      language
    )
    const {
      date,
      readableBaseName
    } = getCompleteFileName(
      jobData.name,
      jobData.args.params
    )
    const reportColumns = jobData?.columnsPdf ?? jobData?.columnsCsv

    const html = template({
      shouldZoomBeAdjusted: this.shouldZoomBeAdjusted,
      apiData,
      jobData,
      reportColumns,
      language,
      isError,
      reportName: readableBaseName ?? 'Report table',
      start: new Date(
        getDateNotLessMinStart(jobData?.args?.params?.start)
      ),
      end: Number.isFinite(jobData?.args?.params?.end)
        ? new Date(jobData.args.params.end)
        : new Date(),
      date: date instanceof Date
        ? date
        : new Date()
    })

    return html
  }

  getTranslator (language) {
    return getTranslator(
      { i18next: this.i18next },
      {
        lng: language,
        ns: TRANSLATION_NAMESPACES.PDF
      }
    )
  }

  addTemplates (params) {
    const {
      fileNames = TEMPLATE_FILE_NAMES,
      templateFolderPath = path.join(__dirname, 'templates')
    } = params ?? {}

    const _fileNames = this.#getFileNameArray(fileNames)

    for (const fileName of _fileNames) {
      if (
        !fileName ||
        typeof fileName !== 'string'
      ) {
        continue
      }

      this.#templatePaths.set(
        fileName,
        path.join(templateFolderPath, fileName)
      )
    }
  }

  #getFileNameArray (fileNames) {
    if (Array.isArray(fileNames)) {
      return fileNames
    }
    if (
      fileNames &&
      typeof fileNames === 'object'
    ) {
      return Object.values(fileNames)
    }

    return [fileNames]
  }

  compileTemplate (opts) {
    const _opts = {
      basedir: this.rootFolderPath,
      pretty: true,
      ...opts
    }
    const languages = this.#getAvailableLanguages()

    for (const language of languages) {
      const translate = this.getTranslator(language)

      for (const [templateFileName, templatePath] of this.#templatePaths) {
        const fn = pug.compileFile(templatePath, {
          ..._opts,
          language,
          filters: {
            translate,
            fonts: () => this.#fonts
          }
        })
        const templateKey = this.#getTemplateKey(
          templateFileName,
          language
        )

        this.#templates.set(templateKey, fn)
      }
    }
  }

  #getAvailableLanguages () {
    return this.i18next.options.preload
  }

  #getTemplateKey (templateFileName, language) {
    const lng = this.#getTemplateLngKey(language)

    return `${templateFileName}:${lng}`
  }

  #getTemplateLngKey (language) {
    const lngs = this.#getAvailableLanguages()

    if (lngs.some((lng) => lng === language)) {
      return language
    }

    const lng = lngs.find((lng) => (
      lng.startsWith(language) ||
      language.startsWith(lng)
    ))

    if (lng) {
      return lng
    }

    const normalizedLng = language.replace(/-\S*/, '')

    return lngs.find(
      (lng) => lng.startsWith(normalizedLng)
    ) ?? language
  }

  #renderFontsTemplate (
    template,
    params = {}
  ) {
    const str = template.replace(placeholderPattern, (match) => {
      const propName = match.replace('${', '').replace('}', '')

      if (
        !Number.isFinite(params?.[propName]) &&
        typeof params?.[propName] !== 'string'
      ) {
        return ''
      }

      return params[propName]
    })

    return str
  }
}

decorateInjectable(PdfWriter, depsTypes)

module.exports = PdfWriter
