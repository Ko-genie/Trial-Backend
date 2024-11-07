// backend directory (index.js)
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors({ origin: 'http://localhost:3000' })); // Adjust if using a different frontend URL

// Hybrid Scraping function: Tries static scraping first, falls back to Puppeteer for dynamic content
async function scrapeProductData(url) {
  try {
    // First attempt: static scraping using Axios and Cheerio
    try {
      const { data } = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const $ = cheerio.load(data);

      // Extract data (title, description, images)
      const title = $('title').text() || 'No title available';
      let description = $('meta[name="description"]').attr('content') || '';
      if (!description || description.length < 10) {
        description = $('p').first().text() || $('h1').first().text() || 'No description found';
      }

      const images = [];
      $('img').each((_, img) => {
        const src = $(img).attr('src');
        if (src && src.startsWith('http')) images.push(src);
      });

      const brandName = $('meta[property="og:site_name"]').attr('content') || new URL(url).hostname;
      const productName = $('h1').first().text() || title || 'Unknown Product';

      if (images.length > 0) {
        console.log('Static scraping successful.');
        return { brandName, productName, productDescription: description, images };
      }
    } catch (error) {
      console.warn('Static scraping failed, switching to Puppeteer:', error.message);
    }

    // Fallback to Puppeteer if static scraping fails or returns no images
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });

    const scrapedData = await page.evaluate(() => {
      const baseUrl = document.location.origin;
      const images = Array.from(document.querySelectorAll('img'))
        .map((img) => (img.src.startsWith('http') ? img.src : `${baseUrl}${img.src}`))
        .filter((src) => {
          // Filter out unwanted images based on known patterns and formats
          const unwantedPatterns = /(loading|sprite|icon|transparent|grey|pixel|gif|svg|sash)/i;
          const validFormats = /\.(jpg|jpeg|png|webp)$/i;
          return validFormats.test(src) && !unwantedPatterns.test(src);
        });
    
      const title = document.title || 'No title available';
      let description = document.querySelector('meta[name="description"]')?.content || '';
      if (!description || description.length < 10) {
        description = document.querySelector('p')?.innerText || document.querySelector('h1')?.innerText || 'No description found';
      }
    
      const brandName = document.querySelector('meta[property="og:site_name"]')?.content || new URL(window.location.href).hostname;
      const productName = document.querySelector('h1')?.innerText || title || 'Unknown Product';
    
      return { brandName, productName, productDescription: description, images };
    });

    await browser.close();
    return scrapedData;
  } catch (error) {
    console.error('Error scraping product data:', error.message);
    throw new Error('Failed to scrape product data');
  }
}

// Manual Ad Generation endpoint
app.post('/generateAdPrompt', async (req, res) => {
  const { brandName, productName, productDescription, targetAudience, uniqueSellingPoints } = req.body;

  // Validate the input fields
  if (!brandName || !productName || !productDescription || !targetAudience || !uniqueSellingPoints) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    // Construct a prompt for GPT-4 based on manual entry
    const prompt = `Generate an engaging ad for the following product:
                    Brand: ${brandName}
                    Product: ${productName}
                    Description: ${productDescription}
                    Target Audience: ${targetAudience}
                    Unique Selling Points: ${uniqueSellingPoints}`;

    const gptResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-4",
        messages: [
          { role: "system", content: "You are an AI that generates ad copy." },
          { role: "user", content: prompt }
        ],
        max_tokens: 150
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const adCopy = gptResponse.data.choices[0].message.content;

    // Send generated ad copy and original data back to the frontend
    res.json({
      brandName,
      productName,
      productDescription,
      targetAudience,
      uniqueSellingPoints,
      adCopy
    });
  } catch (error) {
    console.error('Error generating ad:', error);
    res.status(500).json({ message: 'Error generating ad', error: error.message });
  }
});


// Generate Ad endpoint
app.post('/createAd', async (req, res) => {
  const { url, gender, ageGroup } = req.body;
  if (!url) return res.status(400).json({ message: 'No URL provided' });

  try {
    const productData = await scrapeProductData(url);

    // Ad description customization based on demographics
    let targetDescription = '';
    if (gender === 'female') {
      if (ageGroup === '9-18') targetDescription = 'Appeal to young girls with fun, color, and trendy designs.';
      else if (ageGroup === '18-25') targetDescription = 'Emphasize style, comfort, and empowerment.';
      else if (ageGroup === '25-40') targetDescription = 'Focus on comfort, elegance, and professional appeal.';
      else if (ageGroup === '40-60') targetDescription = 'Emphasize comfort, sophistication, and practicality.';
      else if (ageGroup === '60+') targetDescription = 'Highlight comfort, elegance, and relaxation.';
    } else if (gender === 'male') {
      if (ageGroup === '9-18') targetDescription = 'Appeal to young boys or teens with energy and coolness.';
      else if (ageGroup === '18-25') targetDescription = 'Focus on style, confidence, and boldness.';
      else if (ageGroup === '25-40') targetDescription = 'Emphasize practicality, style, and versatility.';
      else if (ageGroup === '40-60') targetDescription = 'Appeal with quality, durability, and classic style.';
      else if (ageGroup === '60+') targetDescription = 'Highlight comfort and ease of use.';
    }

    const prompt = `Generate an ad for the following product:
                    Brand: ${productData.brandName}
                    Product: ${productData.productName}
                    Description: ${productData.productDescription}
                    Targeted at a ${gender} audience in the age group of ${ageGroup}.
                    ${targetDescription}`;

    const gptResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-4",
        messages: [
          { role: "system", content: "You are an AI that generates ad copy." },
          { role: "user", content: prompt }
        ],
        max_tokens: 150
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const adCopy = gptResponse.data.choices[0].message.content;
    res.json({ ...productData, adCopy });
  } catch (error) {
    console.error('Error generating ad:', error);
    res.status(500).json({ message: 'Error generating ad', error: error.message });
  }
});

// Image proxy endpoint
app.post('/image-proxy', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'No URL provided' });
  }

  try {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // Set User-Agent and navigate to the URL
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.183 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Extract all image URLs with filtering
    const imageUrls = await page.evaluate(() => {
      const images = [];
      const unwantedPatterns = /(sprite|icon|placeholder|grey|pixel|loading|gif|svg)/i; // Unwanted patterns
      const validFormats = /\.(jpg|jpeg|png|webp)$/i; // Supported formats

      document.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-srcset');
        if (src && validFormats.test(src) && !unwantedPatterns.test(src)) {
          // Convert to absolute URL if necessary
          const imageUrl = src.startsWith('http') ? src : new URL(src, window.location.href).href;
          images.push(imageUrl);
        }
      });

      return images;
    });

    await browser.close();

    // Send back the scraped image URLs
    res.json({ images: imageUrls });
  } catch (error) {
    console.error('Error scraping images:', error);
    res.status(500).json({ error: 'Failed to scrape images' });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
