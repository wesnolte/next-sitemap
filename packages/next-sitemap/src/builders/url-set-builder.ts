import { removeIfMatchPattern } from '../utils/array.js'
import { defaultSitemapTransformer } from '../utils/defaults.js'
import {
  createDefaultLocaleReplace,
  entityEscapedUrl,
  generateUrl,
  isNextInternalUrl,
} from '../utils/url.js'
import type { IConfig, ISitemapField, INextManifest } from '../interface.js'

import * as fs from 'node:fs/promises'

const regex = /({"name":"export-page".*?)(?=,{"name":"export-page")/g;

export class UrlSetBuilder {
  config: IConfig

  manifest: INextManifest

  constructor(config: IConfig, manifest: INextManifest) {
    this.config = config
    this.manifest = manifest
  }

  /**
   * Returns absolute url by combining siteUrl and path w.r.t trailingSlash config
   * @param siteUrl
   * @param path
   * @param trailingSlash
   * @returns
   */
  absoluteUrl(siteUrl: string, path: string, trailingSlash?: boolean): string {
    const url = generateUrl(siteUrl, trailingSlash ? `${path}/` : path)

    if (!trailingSlash && url.endsWith('/')) {
      return url.slice(0, url.length - 1)
    }

    return entityEscapedUrl(url)
  }

  /**
   * Normalize sitemap fields to include absolute urls
   * @param field
   */
  normalizeSitemapField(field: ISitemapField): ISitemapField {
    // Handle trailing Slash
    const trailingSlash =
      'trailingSlash' in field
        ? field.trailingSlash
        : this.config?.trailingSlash

    return {
      ...field,
      trailingSlash,
      loc: this.absoluteUrl(this.config?.siteUrl, field?.loc, trailingSlash), // create absolute urls based on sitemap fields
      alternateRefs: (field.alternateRefs ?? []).map((alternateRef) => ({
        href: alternateRef.hrefIsAbsolute
          ? alternateRef.href
          : this.absoluteUrl(alternateRef.href, field.loc, trailingSlash),
        hreflang: alternateRef.hreflang,
      })),
    }
  }

  /**
   * Create a unique url set
   */
  async createUrlSet(): Promise<ISitemapField[]> {
    // Load i18n routes
    const i18n = this.manifest?.routes?.i18n
    const traceFilename = `${this.config.sourceDir}trace`
    console.log(this.config.sourceDir)

    // Init all page keys
    let allKeys: string[] = []

    const data = await fs.readFile(traceFilename, { encoding: 'utf-8' })

    // fs.readFile(traceFilename, "utf-8", function (err, data) {
    //   if (err) {
    //     console.log(err);
    //     return;
    //   }
    const tracePathObjects = data.match(regex);

    tracePathObjects?.forEach((obj) => {
      const jsonObj = JSON.parse(obj);
      allKeys.push(jsonObj.tags.path);
    });
    // });

    // Filter out next.js internal urls and generate urls based on sitemap
    let urlSet = allKeys.filter((x) => !isNextInternalUrl(x))

    // Remove default locale if i18n is enabled
    let defaultLocale
    if (i18n) {
      defaultLocale = i18n.defaultLocale
      const replaceDefaultLocale = createDefaultLocaleReplace(defaultLocale)
      urlSet = urlSet.map(replaceDefaultLocale)
    }

    // Remove the urls based on this.config?.exclude array
    if (this.config?.exclude) {
      if (typeof this.config.exclude === 'function') {
        const asyncExcludes = await this.config.exclude()
        urlSet = removeIfMatchPattern(urlSet, asyncExcludes)
      } else {
        urlSet = removeIfMatchPattern(urlSet, this.config?.exclude)
      }
    }

    urlSet = [...new Set(urlSet)]

    // Remove routes which don't exist
    const notFoundRoutes = (this.manifest?.preRender?.notFoundRoutes ??
      []) as string[]
    urlSet = urlSet.filter((url) => {
      return (
        !notFoundRoutes.includes(url) &&
        !notFoundRoutes.includes(`/${defaultLocale}${url}`)
      )
    })

    // Create sitemap fields based on transformation
    const sitemapFields: ISitemapField[] = [] // transform using relative urls

    // Create a map of fields by loc to quickly find collisions
    const mapFieldsByLoc: { [key in string]: ISitemapField } = {}

    for (const url of urlSet) {
      const sitemapField = await this.config?.transform?.(this.config, url)

      if (!sitemapField?.loc) continue

      sitemapFields.push(sitemapField)

      // Add link on field to map by loc
      if (this.config?.additionalPaths) {
        mapFieldsByLoc[sitemapField.loc] = sitemapField
      }
    }

    if (this.config?.additionalPaths) {
      const additions =
        (await this.config?.additionalPaths({
          ...this.config,
          transform: this.config?.transform ?? defaultSitemapTransformer,
        })) ?? []

      for (const field of additions) {
        if (!field?.loc) continue

        const collision = mapFieldsByLoc[field.loc]

        // Update first entry
        if (collision) {
          // Mutate common entry between sitemapFields and mapFieldsByLoc (spread operator don't work)
          Object.entries(field).forEach(
            ([key, value]) => (collision[key] = value),
          )
          continue
        }

        sitemapFields.push(field)
      }
    }

    return sitemapFields.map((x) => this.normalizeSitemapField(x))
  }
}
