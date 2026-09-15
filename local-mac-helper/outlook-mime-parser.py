"""Bounded, read-only parsing of an Outlook source file. Never logs mail content."""
import sys, os, json, hashlib, email.policy, email.parser, email.utils, datetime, re
MAX_BYTES = 64 * 1024 * 1024

def normal(text):
    return str(text or '').replace('\r\n', '\n').strip()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def stamp(value):
    try:
        value = email.utils.parsedate_to_datetime(str(value))
        if value.tzinfo is None: return None
        return value.astimezone(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
    except Exception: return None

def addresses(values):
    return sorted(set(address.lower() for _, address in email.utils.getaddresses([str(x) for x in values]) if address))

def parse(raw):
    if not raw or len(raw) > MAX_BYTES: raise ValueError('MIME_SIZE_LIMIT')
    header_end = re.search(br'\r?\n\r?\n', raw)
    if not header_end or header_end.start() > 256*1024: raise ValueError('MIME_HEADERS_INVALID')
    message = email.parser.BytesParser(policy=email.policy.default).parsebytes(raw)
    ids = message.get_all('Message-ID', [])
    if len(ids) != 1 or not re.fullmatch(r'<[^\s<>]{1,500}@[^\s<>]{1,250}>', str(ids[0]).strip()): raise ValueError('MIME_MESSAGE_ID_INVALID')
    for key in ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date']:
        if len(message.get_all(key, [])) > 1: raise ValueError('MIME_DUPLICATE_HEADER')
    if any(type(d).__name__ in ['StartBoundaryNotFoundDefect', 'CloseBoundaryNotFoundDefect', 'MultipartInvariantViolationDefect'] for part in message.walk() for d in part.defects): raise ValueError('MIME_TRUNCATED')
    sent_at = stamp(message.get('Date'))
    received_at = None
    for value in message.get_all('Received', []):
        received_at = stamp(str(value).rsplit(';', 1)[-1])
        if received_at: break
    body_part = message.get_body(preferencelist=('plain', 'html'))
    body = ''
    body_type = None
    if body_part:
        body_type = body_part.get_content_type()
        body = body_part.get_content()
        if not isinstance(body, str): raise ValueError('MIME_BODY_INVALID')
    attachments, originals = [], []
    for part in message.walk():
        if len(attachments) > 100: raise ValueError('MIME_ATTACHMENT_LIMIT')
        if part.get_content_type() == 'message/rfc822':
            for original in part.get_payload() if isinstance(part.get_payload(), list) else []:
                oid = str(original.get('Message-ID', '')).strip()
                if oid: originals.append(oid)
        filename = part.get_filename()
        if filename or part.get_content_disposition() == 'attachment':
            data = part.get_payload(decode=True)
            if data is None:
                data = b''.join(x.as_bytes() for x in part.get_payload()) if isinstance(part.get_payload(), list) else b''
            if len(data) > MAX_BYTES: raise ValueError('MIME_ATTACHMENT_LIMIT')
            attachments.append({'name': str(filename or ''), 'sha256': sha(data), 'size': len(data), 'contentType': part.get_content_type(), 'disposition': part.get_content_disposition() or 'inline'})
    references = re.findall(r'<[^<>\s]+@[^<>\s]+>', ' '.join(str(message.get(k, '')) for k in ['References', 'In-Reply-To']))
    return {'messageId': str(ids[0]).strip(), 'sentAt': sent_at, 'receivedAt': received_at, 'sender': addresses(message.get_all('From', [])), 'recipients': addresses(message.get_all('To', [])), 'cc': addresses(message.get_all('Cc', [])), 'bcc': addresses(message.get_all('Bcc', [])), 'subject': normal(message.get('Subject', '')), 'body': normal(body), 'bodyType': body_type, 'bodyHash': sha(normal(body).encode('utf-8')), 'attachments': attachments, 'references': list(dict.fromkeys(references)), 'originalMessageIds': originals, 'sourceHash': sha(raw)}

if __name__ == '__main__':
    try:
        descriptor = os.open(sys.argv[1], os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(descriptor, 'rb') as source:
            if os.fstat(source.fileno()).st_size > MAX_BYTES: raise ValueError('MIME_SIZE_LIMIT')
            result = parse(source.read(MAX_BYTES+1))
        print(json.dumps(result, ensure_ascii=True))
    except Exception as error:
        # Do not leak headers, body, filename or native exception details.
        print(json.dumps({'error': str(error) if str(error).startswith('MIME_') else 'MIME_PARSE_FAILED'}))
        sys.exit(1)
