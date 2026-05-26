# How RAG works in WeBrain

When you upload a file, WeBrain splits it into ~500-token chunks, generates an embedding vector for each chunk with `all-MiniLM-L6-v2`, and stores them indexed by document.

At chat time the user's question is also embedded, the top-K (default 3) most similar chunks are retrieved, and they're injected into the chat system prompt as `## Retrieved context`. The AI's reply then cites those chunks as `[1] [2] [3]` footnotes under the message.

This is what lets you ask "what was that thing in Chapter 4?" without re-pasting the chapter.
