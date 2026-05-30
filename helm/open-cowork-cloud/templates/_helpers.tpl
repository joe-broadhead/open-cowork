{{- define "open-cowork-cloud.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "open-cowork-cloud.fullname" -}}
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

{{- define "open-cowork-cloud.labels" -}}
app.kubernetes.io/name: {{ include "open-cowork-cloud.name" . }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "open-cowork-cloud.selectorLabels" -}}
app.kubernetes.io/name: {{ include "open-cowork-cloud.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "open-cowork-cloud.secretName" -}}
{{- if .Values.cloud.existingSecret -}}
{{- .Values.cloud.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "open-cowork-cloud.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "open-cowork-cloud.serviceAccountName" -}}
{{- if .Values.serviceAccount.name -}}
{{- .Values.serviceAccount.name -}}
{{- else if .Values.serviceAccount.create -}}
{{- include "open-cowork-cloud.fullname" . -}}
{{- else -}}
{{- "default" -}}
{{- end -}}
{{- end -}}

{{- define "open-cowork-cloud.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end -}}
