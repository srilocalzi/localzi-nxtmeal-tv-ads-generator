# localzi-nxtmeal-tv-ads-generator

AWS Lambda service that generates TV advertisement videos for NXT Meal store locations by composing menu data onto pre-designed slide templates.

## Architecture

```
┌─────────────────┐     ┌──────────────────────────┐     ┌─────────────┐
│  Octopus Admin  │────▶│  TV Ads Generator Lambda │────▶│  S3 Output  │
│  (Frontend)     │     │                          │     │  (MP4)      │
└─────────────────┘     └──────────────────────────┘     └─────────────┘
                               │         │
                               ▼         ▼
                        ┌──────────┐ ┌──────────────┐
                        │ DynamoDB │ │ S3 Templates │
                        │ (Menus)  │ │ (Slides BG)  │
                        └──────────┘ └──────────────┘
```

## How It Works

1. **Receives request** with `subLocationID`, `date`, `menuTypes[]`
2. **Fetches clients** (counters) for the subLocation from DynamoDB
3. **Fetches menus** for each client on the specified date
4. **Downloads slide templates** from S3
5. **Composes text** (menu items, prices, names) onto slide backgrounds using Sharp
6. **Stitches slides into MP4** using FFmpeg (Lambda Layer) with configurable duration per slide
7. **Uploads MP4** to S3 output bucket
8. **Returns playable URL** (CloudFront CDN)

## API

### POST - Generate Video
```json
{
  "action": "generate",
  "subLocationID": "123456",
  "subLocationName": "Tech Park Cafeteria",
  "date": "2025/01/15",
  "menuTypes": ["breakfast", "lunch"]
}
```

**Response:**
```json
{
  "statusCode": 200,
  "body": {
    "videoUrl": "https://cdn.example.com/tv-ads/videos/123456/tv-ad-123456-2025-01-15-1705312000.mp4",
    "s3Key": "videos/123456/tv-ad-123456-2025-01-15-1705312000.mp4",
    "slideCount": 12,
    "clientCount": 3,
    "generatedAt": "2025-01-15T10:30:00.000Z"
  }
}
```

### GET - Generation History
```
?subLocationID=123456
```

## Slide Templates

Upload slide backgrounds to S3 bucket under `templates/` prefix:
- `templates/brand-intro.png` - Brand introduction slide
- `templates/top-selling-header.png` - Section header for top selling
- `templates/menu-items.png` - Menu items layout (left: food image area, right: text)
- `templates/party-orders.png` - Party/catering info
- `templates/download-app.png` - App download CTA
- `templates/corporate-cafeteria.png` - Corporate intro slide

## Prerequisites

- **FFmpeg Lambda Layer**: Add the FFmpeg layer to the Lambda function
  - ARN: `arn:aws:lambda:ap-south-1:ACCOUNT:layer:ffmpeg:1`
- **Sharp**: Included in dependencies (auto-builds for Lambda's Linux environment)
- **S3 Buckets**: Create template and output buckets
- **DynamoDB Tables**: Client and Menu tables must exist

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| ENVIRONMENT | PRODUCTION or DEVELOPMENT | PRODUCTION |
| CDN_BASE_URL | CloudFront base URL | https://d2nahbmqd5vvug.cloudfront.net |
| FFMPEG_PATH | Path to FFmpeg binary | /opt/bin/ffmpeg |

## Deployment

```bash
npm install --production
zip -r function.zip . -x "test/*" "*.md"
# Deploy via Jenkins pipeline or SAM CLI
```

## Testing

```bash
npm test
```
