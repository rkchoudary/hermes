/**
 * FastAPI 0.100+ patterns.
 */
import type { Retriever } from '../index';

const FASTAPI_PATTERNS = `
**Modern FastAPI — Annotated parameters (FastAPI 0.95+):**

\`\`\`python
from fastapi import FastAPI, Depends, Query
from typing import Annotated

app = FastAPI()

@app.get('/items/')
async def list_items(
    q: Annotated[str | None, Query(max_length=50)] = None,
    db: Annotated[Session, Depends(get_db)] = None,
):
    return db.query(Item).filter(Item.name.contains(q or '')).all()
\`\`\`

**Dependency injection — request-scoped DB session:**

\`\`\`python
def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()
\`\`\`

**Pydantic v2 (FastAPI ≥0.100 ships v2):**

- \`BaseModel.model_validate(data)\` (not \`.parse_obj()\`)
- \`BaseModel.model_dump()\` (not \`.dict()\`)
- \`Field(default=..., description=...)\` for OpenAPI metadata
- Custom validators: \`@field_validator('name')\` (not \`@validator\`)
- \`model_config = ConfigDict(from_attributes=True)\` for SQLAlchemy ORM

**Async vs sync:**
- Use \`async def\` for IO-bound endpoints (DB queries, HTTP calls)
- Use \`def\` for CPU-bound or sync-only libraries (FastAPI runs them in a threadpool)
- Don't mix: never \`await\` inside a sync function

**Background tasks vs Celery:**
- \`BackgroundTasks\` for "fire and forget" small things (send email, log audit)
- Celery / RQ for retryable work, queues, scheduling — anything that must survive a restart

**Common pitfalls:**
- Don't define dependencies inside the endpoint function — declare at module level
- Don't return SQLAlchemy models directly; use response_model + Pydantic
- Don't use \`list\` / \`dict\` annotations for body params — FastAPI treats them as query params
- Always pin Pydantic in pyproject.toml; v1 → v2 is breaking
`;

export const fastapiRetriever: Retriever = {
  name: 'fastapi@0.100+',
  matches(pack) {
    const hints = [...(pack.allowed_paths || []), ...(pack.references?.code_paths || []), pack.objective || ''].join(' ').toLowerCase();
    return /fastapi|@app\.(get|post|put|delete|patch)|pydantic|sqlmodel/.test(hints);
  },
  async enrich(_pack) { return FASTAPI_PATTERNS.trim(); },
};
