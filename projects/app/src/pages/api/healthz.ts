import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(_request: NextApiRequest, response: NextApiResponse): void {
  response.status(200).json({
    status: 'ok',
    checks: [],
    timestamp: new Date().toISOString(),
  });
}
