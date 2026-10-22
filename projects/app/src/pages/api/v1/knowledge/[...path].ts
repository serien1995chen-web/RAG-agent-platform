import { createKnowledgeApiHandler } from '../../../../shared/knowledge-api';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default createKnowledgeApiHandler();
