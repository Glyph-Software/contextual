export interface RetrievalWarning {
  code: 'EMBEDDINGS_DISABLED' | 'EMBEDDING_MODEL_MISMATCH' | 'EMBEDDING_UNAVAILABLE' | 'EMBEDDING_AUTH_FAILED' | 'RERANK_UNAVAILABLE';
  message: string;
  retryable: boolean;
  suggested_action: string;
}

export interface RetrievalDiagnostics {
  retrieval_mode: 'full_text' | 'hybrid' | 'skill_metadata';
  warnings: RetrievalWarning[];
}
