import { createKnowledgeApiHandler } from '../../../../shared/knowledge-api';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default createKnowledgeApiHandler();
