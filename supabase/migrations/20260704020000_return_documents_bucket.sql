INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'return-documents',
  'return-documents',
  false,
  10485760,
  ARRAY['application/pdf','image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "return_documents_insert" ON storage.objects
  FOR INSERT TO public
  WITH CHECK (bucket_id = 'return-documents');

CREATE POLICY "return_documents_read" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'return-documents' AND is_internal_user());

CREATE POLICY "return_documents_delete" ON storage.objects
  FOR DELETE TO public
  USING (bucket_id = 'return-documents' AND is_internal_user());
