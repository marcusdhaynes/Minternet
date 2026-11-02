# Run and build Minternet

Node.js 24+:

```sh
npm install
npm run check
npm test
npm start
```

GitHub Actions workflows:
- **Security and tests** runs on main pushes, pull requests and manual dispatch.
- **Desktop build (unsigned preview)** can be manually dispatched on Windows, macOS and Linux.
- **Dependabot** checks npm dependencies and GitHub Actions dependencies weekly.

Packages are unsigned. Production deployment requires signing, notarization, verified updates and security audits.

Supabase SQL is provided in `supabase/schema.sql`, but is **not deployed or connected**.
