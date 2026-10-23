"""Thread-scoped document upload and extraction endpoints."""

from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from arete.services import documents

router = APIRouter(prefix="/agent/threads/{thread_id}", tags=["documents"])


class UploadIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    size: int = Field(gt=0, le=documents.MAX_FILE_BYTES)
    sha256: str = Field(pattern="^[0-9a-f]{64}$")


@router.get("/documents")
def list_documents(thread_id: UUID):
    return documents.list_documents(str(thread_id))


@router.post("/documents", status_code=201)
def begin_upload(thread_id: UUID, body: UploadIn):
    return documents.begin_upload(str(thread_id), **body.model_dump())


@router.put("/documents/{document_id}/chunks/{position}")
async def upload_chunk(
    thread_id: UUID, document_id: UUID, position: int, request: Request
):
    from anyio import to_thread

    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > documents.CHUNK_BYTES:
            raise HTTPException(413, "Bloc trop volumineux.")
        data.extend(chunk)
    await to_thread.run_sync(
        documents.put_chunk, str(thread_id), str(document_id), position, bytes(data)
    )
    return {"uploaded": True}


@router.post("/documents/{document_id}/finalize")
def finalize(
    thread_id: UUID, document_id: UUID, body: documents.Extraction | None = None
):
    return documents.finalize(str(thread_id), str(document_id), body)


@router.get("/documents/{document_id}/extraction")
def extraction(thread_id: UUID, document_id: UUID):
    return documents.extraction_for(str(thread_id), str(document_id))


@router.get("/documents/{document_id}/chunks/{position}")
def download_chunk(thread_id: UUID, document_id: UUID, position: int):
    _, raw = documents.original(str(thread_id), str(document_id))
    start = position * documents.CHUNK_BYTES
    if position < 0 or start >= len(raw):
        raise HTTPException(404, "Bloc introuvable.")
    return Response(
        raw[start : start + documents.CHUNK_BYTES],
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.delete("/documents/{document_id}")
def delete_document(thread_id: UUID, document_id: UUID):
    documents.delete_documents(str(thread_id), str(document_id))
    return {"deleted": True}


@router.delete("")
def delete_thread(thread_id: UUID):
    documents.delete_documents(str(thread_id))
    return {"deleted": True}
