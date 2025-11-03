# Blog Sync Utility

This utility allows you to manually synchronize blog posts from GitHub Discussions using GitHub App authentication.

## Setup

1. **Create a GitHub App** (if not already done):
   - Go to GitHub Settings → Developer settings → GitHub Apps
   - Create a new GitHub App with `Discussions: Read` permission
   - Install the app on your repository
   - Download the private key (.pem file)

2. **Set Environment Variables**:
   ```bash
   export GITHUB_APP_ID=your_app_id_here
   export GITHUB_APP_PRIVATE_KEY_PATH=./keys/github-app-key.pem
   ```

## Usage

### Option 1: Using npm script (Recommended)
```bash
npm run blog-sync
```

### Option 2: Direct execution
```bash
node scripts/blog-sync.js
```

## What it does

1. **Authenticates with GitHub App**: Uses JWT tokens for secure authentication
2. **Fetches Discussions**: Retrieves all discussions from the "Blog" category in the arete-org/arete repository
3. **Processes Posts**: Converts each discussion into a blog post JSON file
4. **Fetches Comments**: Gets the actual comment count for each discussion
5. **Updates Index**: Creates/updates the blog index with all posts
6. **Saves Files**: Writes all files to `packages/web/public/blog-posts/`

## Output

The script will:
- Create individual JSON files for each blog post: `{number}.json`
- Update the main index file: `index.json`
- Show progress and completion status

## Example Output

```
🚀 Starting manual blog sync with GitHub App...
📡 Fetching discussions from GitHub...
📚 Found 3 blog discussions
✅ Synced blog post: Getting Started with ARETE (#123)
✅ Synced blog post: Advanced Configuration (#124)
✅ Synced blog post: Troubleshooting Guide (#125)
📝 Updated blog index with 3 posts
🎉 Blog sync completed! Synced 3 posts
```

## Troubleshooting

- **"GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH environment variables are required"**: Set your GitHub App credentials as shown in setup
- **"GitHub App not installed on arete-org/arete"**: Make sure you've installed the GitHub App on your repository
- **"Could not fetch comments"**: This is a warning, posts will still sync with comment count 0

## Files Created

- `packages/web/public/blog-posts/index.json` - Main index of all posts
- `packages/web/public/blog-posts/{number}.json` - Individual post files
