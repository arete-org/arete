#!/usr/bin/env node

/**
 * Manual Blog Sync Utility
 * 
 * This script allows you to manually sync blog posts from GitHub Discussions
 * using GitHub App authentication instead of personal access tokens.
 */

// Load environment variables from .env file
require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Configuration
const BLOG_POSTS_DIR = path.join(__dirname, '..', 'packages', 'web', 'public', 'blog-posts');
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_PRIVATE_KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const REPO_OWNER = 'arete-org';
const REPO_NAME = 'arete';
const CATEGORY_NAME = 'Blog';

/**
 * Generates a JWT token for GitHub App authentication
 */
function generateJWT() {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY_PATH) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH environment variables are required');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // Issued at (1 minute ago to account for clock skew)
    exp: now + 600, // Expires in 10 minutes
    iss: GITHUB_APP_ID // Issuer (App ID)
  };

  const privateKey = require('fs').readFileSync(GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
  
  return require('jsonwebtoken').sign(payload, privateKey, { algorithm: 'RS256' });
}

/**
 * Gets an installation access token for the repository
 */
async function getInstallationToken() {
  const jwt = generateJWT();
  
  // First, get the installation ID
  const installationsResponse = await fetch('https://api.github.com/app/installations', {
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'ARETE-Blog-Sync'
    }
  });

  if (!installationsResponse.ok) {
    throw new Error(`Failed to get installations: ${installationsResponse.status} ${installationsResponse.statusText}`);
  }

  const installations = await installationsResponse.json();
  const installation = installations.find(inst => 
    inst.account.login === REPO_OWNER
  );

  if (!installation) {
    throw new Error(`GitHub App not installed on ${REPO_OWNER}/${REPO_NAME}`);
  }

  // Get installation access token
  const tokenResponse = await fetch(`https://api.github.com/app/installations/${installation.id}/access_tokens`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'ARETE-Blog-Sync'
    }
  });

  if (!tokenResponse.ok) {
    throw new Error(`Failed to get installation token: ${tokenResponse.status} ${tokenResponse.statusText}`);
  }

  const tokenData = await tokenResponse.json();
  return tokenData.token;
}

/**
 * Fetches discussions from GitHub API
 */
async function fetchDiscussions() {
  const token = await getInstallationToken();
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/discussions`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'ARETE-Blog-Sync'
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const discussions = await response.json();
  
  // Filter for Blog category discussions
  return discussions.filter(discussion => 
    discussion.category?.name === CATEGORY_NAME
  );
}

/**
 * Fetches comments count for a discussion
 */
async function fetchCommentsCount(discussionNumber) {
  try {
    const token = await getInstallationToken();
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/discussions/${discussionNumber}/comments`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'ARETE-Blog-Sync'
      }
    });

    if (!response.ok) {
      console.warn(`Could not fetch comments for discussion ${discussionNumber}`);
      return 0;
    }

    const comments = await response.json();
    return comments.length;
  } catch (error) {
    console.warn(`Error fetching comments for discussion ${discussionNumber}:`, error.message);
    return 0;
  }
}

/**
 * Writes a blog post to the file system
 */
async function writeBlogPost(discussion) {
  try {
    await fs.mkdir(BLOG_POSTS_DIR, { recursive: true });
    
    // Fetch comment count
    const commentCount = await fetchCommentsCount(discussion.number);
    
    const postObject = {
      number: discussion.number,
      title: discussion.title,
      body: discussion.body,
      author: {
        login: discussion.user.login,
        avatarUrl: discussion.user.avatar_url,
        profileUrl: discussion.user.html_url
      },
      createdAt: discussion.created_at,
      updatedAt: discussion.updated_at,
      discussionUrl: discussion.html_url,
      commentCount: commentCount
    };
    
    const postFilePath = path.join(BLOG_POSTS_DIR, `${discussion.number}.json`);
    await fs.writeFile(postFilePath, JSON.stringify(postObject, null, 2));
    
    console.log(`✅ Synced blog post: ${discussion.title} (#${discussion.number})`);
    return postObject;
  } catch (error) {
    console.error(`❌ Error writing blog post ${discussion.number}:`, error);
    throw error;
  }
}

/**
 * Updates the blog index
 */
async function updateBlogIndex(posts) {
  const indexArray = posts.map(post => ({
    number: post.number,
    title: post.title,
    author: post.author,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt
  }));
  
  // Sort by number descending (newest first)
  indexArray.sort((a, b) => b.number - a.number);
  
  const indexFilePath = path.join(BLOG_POSTS_DIR, 'index.json');
  await fs.writeFile(indexFilePath, JSON.stringify(indexArray, null, 2));
  
  console.log(`📝 Updated blog index with ${indexArray.length} posts`);
}

/**
 * Main sync function
 */
async function syncBlog() {
  try {
    console.log('🚀 Starting manual blog sync with GitHub App...');
    
    // Fetch discussions
    console.log('📡 Fetching discussions from GitHub...');
    const discussions = await fetchDiscussions();
    
    if (discussions.length === 0) {
      console.log('ℹ️  No blog discussions found');
      return;
    }
    
    console.log(`📚 Found ${discussions.length} blog discussions`);
    
    // Process each discussion
    const posts = [];
    for (const discussion of discussions) {
      try {
        const post = await writeBlogPost(discussion);
        posts.push(post);
      } catch (error) {
        console.error(`Failed to process discussion ${discussion.number}:`, error.message);
      }
    }
    
    // Update index
    if (posts.length > 0) {
      await updateBlogIndex(posts);
    }
    
    console.log(`🎉 Blog sync completed! Synced ${posts.length} posts`);
    
  } catch (error) {
    console.error('❌ Blog sync failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  syncBlog();
}

module.exports = { syncBlog, fetchDiscussions, writeBlogPost };
