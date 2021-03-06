// Script for parsing articles and (re-)extracting metadata, including quotes.
// Designed to be safe to re-run and to be non-destrcutive so can be run at
// any time to update the database with the latest changes to the parser.
//
// ********** CAUTION **********
// Running a modified version of script against production could lead to 
// data corruption or loss of data.

// Using `app-module-path` helps with paths resolution in require().
// This makes it easier isomorphic code which leverages aliases in webpack,
// as we don't need to update any files we want to call from the CLI, we
// can just use them as they are, as long as we also run this script with
// 'node-babel' so any babel plugins they need get invoked too.
require('app-module-path').addPath(`${__dirname}/..`)

const { MONGO_ARTICLE_COLLECTION, MONGO_QUOTE_COLLECTION, connect, count: mongoCount } = require('lib/db/mongo')
const { count: elasticsearchCount } = require('lib/db/elasticsearch')
const { addArticle, addQuotesFromArticle } = require('lib/db')
const { fetchHtml } = require('lib/fetch')
const { parseArticle } = require('lib/article')
const Package = require('package.json')

// Set `FORCE_RECRAWL` to true to re-fetch the HTML from the URL instead of using cached HTML
const FORCE_RECRAWL = false

;(async () => {
  try {
    console.log("---- rebuild-index start ----")
    console.log(new Date())

    const db = await connect()

    await ensureIndexes(db)

    console.log("MongoDB:", await mongoCount())
    console.log("Elasticsearch:", await elasticsearchCount(), "\n")

    const cursor = db.collection(MONGO_ARTICLE_COLLECTION).find().addCursorFlag('noCursorTimeout', true) // noCursorTimeout required for long running scripts
    
    // @TODO Note: Could be faster if used bulkwrites (but may be slighly less easy follow)
    // https://stackoverflow.com/questions/25507866/how-can-i-use-a-cursor-foreach-in-mongodb-using-node-js
    while (cursor.hasNext()) {
      try {
        // Get each result and iterate over synchronously (exit while loop when no more results)
        const doc = await cursor.next().then(doc => doc).catch(e => null)
        if (doc === null) break

        if (!doc.url) {
          // Uncomment to prune entries from DB that don't have URL properties
          // console.log(`No URL found for entry document ${doc._id} (removing entry)`)
          // await collection.removeOne({ _id: doc._id })
          continue
        }

        // An example of how to update an a field on an item in place (without updating the entire item)
        // collection.updateOne({ _id: doc._id }, { $set: { "lastUpdated": new Date() } })
        
        let article = {}
        if (FORCE_RECRAWL === true || !doc.html) {
          console.log(`> Fetching HTML for ${doc.url}`)
          const html = await fetchHtml(doc.url)
          article = await parseArticle(doc.url, html)
        } else {
          console.log(`> Parsing HTML for ${doc.url}`)
          article = await parseArticle(doc.url, doc.html)
        }

        console.log("  * Parsed article")

        // Copy crawler metadata fom existing record to new record
        article._crawler = doc._crawler ? doc._crawler : {}

        if (!article._crawler.created) {
          article._crawler.created = new Date()
          article._crawler.updated = article._crawler.created
          article._crawler.version = Package.version
        }
      
        if (FORCE_RECRAWL === true || !doc.html) {
          article._crawler.updated = new Date()
          article._crawler.version = Package.version
        }

        // Save new article object (totally replace old object, to ensure consistancy).
        await addArticle(article)
        console.log("  * Saved article")

        // Save quotes from from the article (uses helper method).
        await addQuotesFromArticle(article)
        console.log(`  * Saved ${article.quotes.length} quotes`)

      } catch (e) {
        console.error(`Error iterating over MongoDB collection`, e)
        continue
      }
    }

    cursor.close()

    console.log("\n---- rebuild-index end ----")
    console.log(new Date())
    console.log("MongoDB:", await mongoCount())
    console.log("Elasticsearch:", await elasticsearchCount())

    process.exit()
  } catch (e) {
    console.error("An error occured while attempting to rebuild index", e)
    process.exit()
  }
})()

function ensureIndexes(mongodb, elasticsearch) {
  return new Promise(async resolve => {
    // Ensure databases have the correct indexes set on them

    // Set MongoDB indexes
    // Quote hashes must be unique, but text and source.url just need to be indexed for performance
    //
    // @FIXME! Source URL and Article URL should be a hash, otherwise will run into problems indexing
    // as the URLs can exceed the maxium length of index values (eg > 1024 bytes) in MongoDB and it
    // does not automatically hash the values. The only fix is to use hashes for the keys (eg `urlHash`).
    //
    // Methods that update URLs in MongoDB (e.g.`getArticle`, `addArticle`, `addQuote`) will need to be
    // updated to be compatible with this change, and the existing index for URLs will need to be dropped.
    // For more info, see:
    // https://stackoverflow.com/questions/27792706/cannot-create-index-in-mongodb-key-too-large-to-index
    await mongodb.createIndex(MONGO_QUOTE_COLLECTION, 'hash', { unique: true })
    await mongodb.createIndex(MONGO_QUOTE_COLLECTION, ['text', 'source.url'])
    // Article URLs must be unique
    await mongodb.createIndex(MONGO_ARTICLE_COLLECTION, 'url', { unique: true })

    // View MongoDB index status
    // console.log(await db.indexInformation(MONGO_QUOTE_COLLECTION))
    // console.log(await db.indexInformation(MONGO_ARTICLE_COLLECTION))

    // Elasticsearch
    // @TODO By default all fields are indexed, but room for optimisation and constraints!

    resolve(true)
  })
}
