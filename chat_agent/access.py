"""Проверка Cloudflare Access JWT в origin, а не доверие одному email-заголовку."""

class AccessDenied(ValueError):
    pass


class CloudflareAccess:
    def __init__(self, team_domain, audience, allowed_emails, *, jwt_module=None):
        allowed = frozenset(email.strip().lower() for email in allowed_emails if email.strip())
        if not team_domain or not audience or not allowed:
            raise ValueError('missing_access_config')
        self.issuer = 'https://' + team_domain.strip().removeprefix('https://').rstrip('/')
        self.audience = audience.strip()
        self.allowed_emails = allowed
        if jwt_module is None:
            import jwt as jwt_module
        self.jwt = jwt_module
        self.jwks = jwt_module.PyJWKClient(self.issuer + '/cdn-cgi/access/certs', cache_keys=True)

    def authorize(self, environ):
        token = environ.get('HTTP_CF_ACCESS_JWT_ASSERTION', '')
        if not token:
            raise AccessDenied('missing_token')
        try:
            key = self.jwks.get_signing_key_from_jwt(token).key
            claims = self.jwt.decode(token, key, algorithms=['RS256'], audience=self.audience,
                                     issuer=self.issuer, options={'require': ['exp', 'iat', 'email', 'aud']})
        except Exception as error:
            raise AccessDenied('invalid_token') from error
        email = claims.get('email', '').strip().lower()
        if email not in self.allowed_emails:
            raise AccessDenied('email_not_allowed')
        return email
