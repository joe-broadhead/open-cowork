{{- define "openwiki.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "openwiki.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openwiki.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "openwiki.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "openwiki.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openwiki.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "openwiki.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "openwiki.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "openwiki.claimName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- include "openwiki.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "openwiki.workspaceBackupClaimName" -}}
{{- if .Values.workspaceBackup.persistence.existingClaim -}}
{{- .Values.workspaceBackup.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-workspace-backups" (include "openwiki.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "openwiki.enterpriseValidation" -}}
{{- if .Values.enterprise.enabled -}}
{{- if not .Values.image.digest -}}
{{- fail "enterprise.enabled requires image.digest to pin the OpenWiki image" -}}
{{- end -}}
{{- if not .Values.openwiki.publicOrigin -}}
{{- fail "enterprise.enabled requires openwiki.publicOrigin" -}}
{{- end -}}
{{- if ne (toString .Values.openwiki.requireAuth) "true" -}}
{{- fail "enterprise.enabled requires openwiki.requireAuth=true" -}}
{{- end -}}
{{- if ne .Values.openwiki.bootstrapMode "skip" -}}
{{- fail "enterprise.enabled requires openwiki.bootstrapMode=skip; run migrations, indexes, and Postgres sync from an explicit deployment job before serving" -}}
{{- end -}}
{{- if not .Values.openwiki.trustedAuthHeaders -}}
{{- fail "enterprise.enabled requires openwiki.trustedAuthHeaders=true so human SSO identity is explicit" -}}
{{- end -}}
{{- if not .Values.openwiki.trustedAuthHeadersSecret.existingSecret -}}
{{- fail "enterprise.enabled requires openwiki.trustedAuthHeadersSecret.existingSecret" -}}
{{- end -}}
{{- if and (ne .Values.openwiki.runtimeBackend "postgres") (or (ne .Values.openwiki.readBackend "postgres") (ne .Values.openwiki.searchBackend "postgres")) -}}
{{- fail "enterprise.enabled requires openwiki.runtimeBackend=postgres or both readBackend/searchBackend=postgres" -}}
{{- end -}}
{{- if ne .Values.openwiki.queueBackend "postgres" -}}
{{- fail "enterprise.enabled requires openwiki.queueBackend=postgres" -}}
{{- end -}}
{{- if ne .Values.openwiki.operationalStateBackend "postgres" -}}
{{- fail "enterprise.enabled requires openwiki.operationalStateBackend=postgres" -}}
{{- end -}}
{{- if ne .Values.openwiki.writeCoordinatorBackend "postgres" -}}
{{- fail "enterprise.enabled requires openwiki.writeCoordinatorBackend=postgres" -}}
{{- end -}}
{{- if not .Values.openwiki.gitRemoteUrl -}}
{{- fail "enterprise.enabled requires openwiki.gitRemoteUrl for Git backup and sync" -}}
{{- end -}}
{{- if not .Values.worker.enabled -}}
{{- fail "enterprise.enabled requires worker.enabled=true" -}}
{{- end -}}
{{- if not .Values.queueReaper.enabled -}}
{{- fail "enterprise.enabled requires queueReaper.enabled=true" -}}
{{- end -}}
{{- if not .Values.networkPolicy.egress -}}
{{- fail "enterprise.enabled requires networkPolicy.egress to declare allowed outbound destinations" -}}
{{- end -}}
{{- end -}}
{{- if and .Values.persistence.enabled .Values.worker.enabled (gt (int .Values.worker.replicaCount) 1) (has "ReadWriteOnce" .Values.persistence.accessModes) -}}
{{- fail "worker.replicaCount > 1 requires persistence.accessModes without ReadWriteOnce or an external shared runtime store" -}}
{{- end -}}
{{- if and (gt (int .Values.replicaCount) 1) (ne .Values.openwiki.operationalStateBackend "postgres") -}}
{{- fail "replicaCount > 1 requires openwiki.operationalStateBackend=postgres for shared MCP sessions and rate limits" -}}
{{- end -}}
{{- /* JOE-979: multi-replica OAuth cannot use file-backed state (single-node). */ -}}
{{- if and (eq (toString .Values.openwiki.oauthEnabled) "true") (gt (int .Values.replicaCount) 1) -}}
{{- if eq (toString .Values.openwiki.oauthStateBackend) "file" -}}
{{- fail "replicaCount > 1 with oauthEnabled requires openwiki.oauthStateBackend=postgres (or omit oauthStateBackend so operationalStateBackend=postgres selects shared OAuth state); file-backed OAuth state is single-node only" -}}
{{- end -}}
{{- if and (ne .Values.openwiki.oauthStateBackend "postgres") (ne .Values.openwiki.operationalStateBackend "postgres") -}}
{{- fail "replicaCount > 1 with oauthEnabled requires openwiki.oauthStateBackend=postgres or openwiki.operationalStateBackend=postgres for shared OAuth clients/codes/tokens" -}}
{{- end -}}
{{- end -}}
{{- if and .Values.openwiki.role (ne .Values.openwiki.host "127.0.0.1") (ne .Values.openwiki.host "localhost") (ne .Values.openwiki.host "::1") -}}
{{- fail "openwiki.role process-wide elevation is only allowed with openwiki.host loopback; map roles per request via trusted headers or tokens" -}}
{{- end -}}
{{- end -}}

{{- define "openwiki.env" -}}
- name: OPENWIKI_ROOT
  value: {{ .Values.openwiki.root | quote }}
- name: OPENWIKI_TITLE
  value: {{ .Values.openwiki.title | quote }}
- name: OPENWIKI_HOST
  value: {{ .Values.openwiki.host | quote }}
- name: OPENWIKI_PORT
  value: {{ .Values.openwiki.port | quote }}
{{- if .Values.openwiki.bootstrapMode }}
- name: OPENWIKI_BOOTSTRAP_MODE
  value: {{ .Values.openwiki.bootstrapMode | quote }}
{{- end }}
{{- if .Values.openwiki.role }}
- name: OPENWIKI_ROLE
  value: {{ .Values.openwiki.role | quote }}
{{- end }}
{{- if .Values.openwiki.runtimeMode }}
- name: OPENWIKI_RUNTIME_MODE
  value: {{ .Values.openwiki.runtimeMode | quote }}
{{- end }}
{{- if .Values.openwiki.publicOrigin }}
- name: OPENWIKI_PUBLIC_ORIGIN
  value: {{ .Values.openwiki.publicOrigin | quote }}
{{- end }}
{{- if ne (toString .Values.openwiki.requireAuth) "" }}
- name: OPENWIKI_REQUIRE_AUTH
  value: {{ .Values.openwiki.requireAuth | quote }}
{{- end }}
{{- if ne (toString .Values.openwiki.oauthEnabled) "" }}
- name: OPENWIKI_OAUTH_ENABLED
  value: {{ .Values.openwiki.oauthEnabled | quote }}
{{- end }}
{{- if .Values.openwiki.oauthIssuer }}
- name: OPENWIKI_OAUTH_ISSUER
  value: {{ .Values.openwiki.oauthIssuer | quote }}
{{- end }}
{{- if .Values.openwiki.oauthStateBackend }}
- name: OPENWIKI_OAUTH_STATE_BACKEND
  value: {{ .Values.openwiki.oauthStateBackend | quote }}
{{- end }}
{{- if ne (toString .Values.openwiki.oauthDynamicClientRegistration) "" }}
- name: OPENWIKI_OAUTH_DYNAMIC_CLIENT_REGISTRATION
  value: {{ .Values.openwiki.oauthDynamicClientRegistration | quote }}
{{- end }}
{{- if .Values.openwiki.runtimeBackend }}
- name: OPENWIKI_RUNTIME_BACKEND
  value: {{ .Values.openwiki.runtimeBackend | quote }}
{{- end }}
{{- if .Values.openwiki.readBackend }}
- name: OPENWIKI_READ_BACKEND
  value: {{ .Values.openwiki.readBackend | quote }}
{{- end }}
{{- if .Values.openwiki.searchBackend }}
- name: OPENWIKI_SEARCH_BACKEND
  value: {{ .Values.openwiki.searchBackend | quote }}
{{- end }}
{{- if .Values.openwiki.queueBackend }}
- name: OPENWIKI_QUEUE_BACKEND
  value: {{ .Values.openwiki.queueBackend | quote }}
{{- end }}
{{- if .Values.openwiki.operationalStateBackend }}
- name: OPENWIKI_OPERATIONAL_STATE_BACKEND
  value: {{ .Values.openwiki.operationalStateBackend | quote }}
{{- end }}
{{- if .Values.openwiki.writeCoordinatorBackend }}
- name: OPENWIKI_WRITE_COORDINATOR_BACKEND
  value: {{ .Values.openwiki.writeCoordinatorBackend | quote }}
{{- end }}
{{- if .Values.openwiki.gitRemoteUrl }}
- name: OPENWIKI_GIT_REMOTE_URL
  value: {{ .Values.openwiki.gitRemoteUrl | quote }}
{{- end }}
{{- if .Values.openwiki.trustedAuthHeaders }}
- name: OPENWIKI_TRUST_AUTH_HEADERS
  value: "1"
- name: OPENWIKI_TRUST_AUTH_HEADERS_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ required "openwiki.trustedAuthHeadersSecret.existingSecret is required when trustedAuthHeaders=true" .Values.openwiki.trustedAuthHeadersSecret.existingSecret | quote }}
      key: {{ .Values.openwiki.trustedAuthHeadersSecret.key | quote }}
{{- end }}
{{- with .Values.openwiki.extraEnv }}
{{- toYaml . }}
{{- end }}
{{- end -}}
