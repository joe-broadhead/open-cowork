import type { LocaleCatalog } from './types'

// French (fr-FR) translation catalog. Keys follow the dot-separated
// scope convention used across the renderer: <surface>.<element>,
// e.g. `homepage.tab.threads` for the Threads tab label on Home.
//
// Style guide for translators:
// - French sentence case (Sentence, not Title Case) for headings.
// - Space-before-punctuation follows French typography
//   (« : », « ? », « ! ») but NOT inside the app — we use the
//   less-formal no-space convention since this is a product UI
//   rather than editorial text.
// - Brand names ({{brandName}}, "OpenCode") are NOT translated.
// - Unit abbreviations (tokens, MCP, API) stay as-is; they're
//   industry terms our target users know in English.

const strings: Record<string, string> = {
  // ────────────────────────────────────────────────────────────
  // Common / shared
  // ────────────────────────────────────────────────────────────
  'common.save': 'Enregistrer',
  'common.cancel': 'Annuler',
  'common.close': 'Fermer',
  'common.delete': 'Supprimer',
  'common.remove': 'Retirer',
  'common.retry': 'Réessayer',
  'common.continue': 'Continuer',
  'common.back': 'Retour',
  'common.loading': 'Chargement…',
  'common.yes': 'Oui',
  'common.no': 'Non',
  'common.unknown': 'Inconnu',
  'common.version': 'Version',

  // ────────────────────────────────────────────────────────────
  // Login / Setup / Loading
  // ────────────────────────────────────────────────────────────
  'login.welcome': 'Bienvenue sur {{brandName}}',
  'login.signInGoogle': 'Se connecter avec Google',
  'login.failed': 'Échec de la connexion',
  'setup.welcomeUser': 'Bienvenue, {{name}}',
  'setup.welcomeGeneric': 'Bienvenue sur {{brandName}}',
  'setup.description': 'Choisissez le fournisseur et le modèle par défaut pour cette version de {{brandName}}.',
  'setup.provider': 'Fournisseur',
  'setup.model': 'Modèle',
  'setup.continue': 'Continuer',
  'setup.saveFailed': 'Impossible d\u2019enregistrer les paramètres.',
  'setup.runtimeFailed': 'Le runtime n\u2019a pas pu démarrer avec les identifiants fournis. Vérifiez votre clé API et réessayez.',
  'loading.boot': 'Démarrage…',
  'loading.auth': 'Vérification de l\u2019authentification…',
  'loading.config': 'Chargement de la configuration…',
  'loading.runtime': 'Démarrage du runtime…',
  'loading.connecting': 'Connexion au runtime…',
  'loading.almostThere': 'Presque prêt…',
  'loading.runtimeNeedsAttention': 'La configuration du runtime nécessite votre attention.',
  'loading.error.title': '{{brandName}} n\u2019a pas pu démarrer le runtime',
  'loading.error.hint': 'Corrigez la configuration invalide, puis relancez l\u2019application.',

  // ────────────────────────────────────────────────────────────
  // Sidebar / navigation
  // ────────────────────────────────────────────────────────────
  'sidebar.home': 'Accueil',
  'sidebar.agents': 'Agents',
  'sidebar.capabilities': 'Capacités',
  'sidebar.settings': 'Paramètres',
  'sidebar.threads': 'Conversations',
  'sidebar.connections': 'Connexions',
  'sidebar.search': 'Rechercher une conversation…',
  'sidebar.searchTitle': 'Rechercher une conversation (⌘K)',
  'sidebar.noThreads': 'Aucune conversation pour le moment',
  'sidebar.noMatches': 'Aucun résultat',
  'sidebar.threadFallback': 'Conversation {{id}}',
  'sidebar.newThread': 'Nouvelle conversation',
  'sidebar.newThreadInProject': 'Nouvelle conversation dans un projet…',
  'newThread.blank': 'Conversation vierge',
  'newThread.blankHint': 'Démarrer avec Build et les agents, outils et compétences actuellement disponibles',
  'newThread.project': 'Ouvrir un projet',
  'newThread.projectHint': 'Choisissez un dossier — l\u2019agent peut lire et modifier les fichiers',
  'sidebar.busy': 'En cours',
  'sidebar.awaitingQuestion': 'En attente de votre réponse',

  // Context menu on thread row
  'thread.rename': 'Renommer',
  'thread.exportMarkdown': 'Exporter en Markdown',
  'thread.shareLink': 'Partager le lien',
  'thread.linkCopied': 'Lien copié !',
  'thread.viewChanges': 'Voir les modifications',
  'thread.delete': 'Supprimer',
  'thread.deleteConfirm': 'Supprimer cette conversation ? Cette action est irréversible.',
  'agent.deleteConfirm': 'Supprimer l\u2019agent « {{name}} » ? Cette action est irréversible.',
  'mcp.deleteConfirm': 'Retirer le MCP « {{name}} » ? Cette action est irréversible.',
  'skill.deleteConfirm': 'Retirer la compétence « {{name}} » ? Cette action est irréversible.',

  // ────────────────────────────────────────────────────────────
  // Status bar
  // ────────────────────────────────────────────────────────────
  'statusbar.ready': 'Prêt',
  'statusbar.runtimeError': 'Erreur runtime',
  'statusbar.sessionUsage': 'Utilisation de la session',
  'statusbar.inputTokens': 'Tokens en entrée',
  'statusbar.outputTokens': 'Tokens en sortie',
  'statusbar.reasoningTokens': 'Tokens de raisonnement',
  'statusbar.cacheTokens': 'Tokens en cache',
  'statusbar.totalTokens': 'Total',
  'statusbar.totalCost': 'Coût total',

  // Runtime offline banner
  'runtime.offline': 'Runtime indisponible : {{error}}',
  'runtime.offlineLabel': 'Runtime indisponible :',
  'runtime.tryAgain': 'Réessayer',
  'runtime.restarting': 'Redémarrage…',

  // ────────────────────────────────────────────────────────────
  // Home dashboard
  // ────────────────────────────────────────────────────────────
  'homepage.title': 'État de l\u2019espace de travail, capacités et santé du runtime en une seule vue.',
  'homepage.subtitle': 'Utilisez l\u2019accueil comme une surface d\u2019observabilité, pas un écran d\u2019accueil. Vérifiez ce qui est chargé, ce qui est connecté, ce que le runtime utilise et où reprendre.',
  'homepage.diagnostics': 'Diagnostics {{brandName}}',
  'homepage.refresh': 'Actualiser',
  'homepage.refreshing': 'Actualisation…',
  'homepage.range.last7d': '7 derniers jours',
  'homepage.range.last30d': '30 derniers jours',
  'homepage.range.ytd': 'Année en cours',
  'homepage.range.all': 'Depuis le début',

  // Status pills
  'homepage.pill.runtime': 'Runtime',
  'homepage.pill.runtimeReady': 'Prêt',
  'homepage.pill.runtimeLoading': 'Chargement des diagnostics',
  'homepage.pill.runtimeNotReady': 'Non prêt',
  'homepage.pill.provider': 'Fournisseur',
  'homepage.pill.providerNotConfigured': 'Non configuré',
  'homepage.pill.context': 'Contexte',
  'homepage.pill.contextTokens': '{{count}} tokens',
  'homepage.pill.contextUnknown': 'Limite inconnue',
  'homepage.pill.mcp': 'MCP',
  'homepage.pill.mcpConnected': '{{connected}}/{{total}} connectés',
  'homepage.pill.capabilities': 'Capacités',
  'homepage.pill.capabilitiesSummary': '{{tools}} outils · {{skills}} compétences',

  // Metric cards
  'homepage.card.toolsAndSkills': 'Outils et compétences',
  'homepage.card.configuredTools': 'Outils configurés',
  'homepage.card.activeSkills': 'Compétences actives',
  'homepage.card.customSkills': 'Compétences personnalisées',
  'homepage.card.customMcps': 'MCP personnalisés',
  'homepage.card.connectedMcps': 'MCP connectés',
  'homepage.card.agents': 'Agents intégrés et personnalisés',
  'homepage.card.primaryModes': 'Modes primaires',
  'homepage.card.builtinAgents': 'Agents intégrés',
  'homepage.card.enabledCustomAgents': 'Agents personnalisés actifs',
  'homepage.card.invalidAgents': 'Agents invalides',
  'homepage.card.leadAgent': 'Agent principal',
  'homepage.card.availableSubAgents': 'Sous-agents disponibles',
  'homepage.card.usage': 'Conversations, tokens et coût',
  'homepage.card.threads': 'Conversations',
  'homepage.card.totalMessages': 'Messages totaux',
  'homepage.card.trackedTokens': 'Tokens suivis',
  'homepage.card.trackedCost': 'Coût suivi',
  'homepage.card.userMessages': 'Messages utilisateur',
  'homepage.card.assistantMessages': 'Messages assistant',
  'homepage.card.toolCalls': 'Appels d\u2019outils',
  'homepage.card.busySessions': 'Sessions actives',
  'homepage.card.refreshedAt': 'Actualisé à {{time}}',
  'homepage.card.agentUsage': 'Utilisation par sous-agent',
  'homepage.card.agentUsageEmpty': 'Aucune délégation de sous-agent pour {{window}}.',
  'homepage.card.perf': 'Performances d\u2019hydratation et de patch',
  'homepage.card.noPerfTelemetry': 'Aucune télémétrie de performance capturée pour l\u2019instant.',

  // Sidebar widgets
  'homepage.side.resumeThreads': 'Reprendre les conversations',
  'homepage.side.resumeEmpty': 'Aucune conversation pour {{window}}.',
  'homepage.side.recentWork': 'Activité récente',
  'homepage.side.actions': 'Actions',
  'homepage.side.openWorkingSurface': 'Ouvrir une surface de travail',
  'homepage.side.newThread': 'Nouvelle conversation',
  'homepage.side.newThreadHint': 'Ouvrir une conversation vierge liée à l\u2019espace de travail.',
  'homepage.side.openDirectory': 'Ouvrir un dossier',
  'homepage.side.openDirectoryHint': 'Ancrer la prochaine session dans une base de code ou un dossier réel.',
  'homepage.side.currentInventory': 'Inventaire actuel',
  'homepage.side.availableTools': 'Outils disponibles',
  'homepage.side.skillBundles': 'Lots de compétences',
  'homepage.side.runtimeInputs': 'Entrées du runtime',
  'homepage.side.opencodeVersion': 'OpenCode',
  'homepage.side.providerName': 'Fournisseur',
  'homepage.side.providerSource': 'Source du fournisseur',
  'homepage.side.model': 'Modèle',
  'homepage.side.modelSource': 'Source du modèle',
  'homepage.side.package': 'Package',
  'homepage.side.packageFallback': 'Intégré/runtime',
  'homepage.side.providerOptions': 'Options fournisseur',
  'homepage.side.credentialOverrides': 'Remplacements d\u2019identifiants',
  'homepage.side.noOptions': 'Aucune option non-secret exposée.',
  'homepage.side.usingDefaults': 'Utilise les valeurs par défaut.',

  // Extra card rows
  'homepage.card.bundledTools': 'Outils intégrés',
  'homepage.card.customTools': 'Outils personnalisés',
  'homepage.card.primaryMode': 'Mode principal',
  'homepage.card.visibleBuiltins': 'Agents intégrés visibles',
  'homepage.card.noToolsDiscovered': 'Aucun outil découvert pour l\u2019instant.',
  'homepage.card.noBuiltinAgents': 'Aucun agent intégré disponible.',
  'homepage.card.tokenMix': 'Répartition des tokens',
  'homepage.card.window': 'Fenêtre',
  'homepage.card.usageRefreshed': 'Usage actualisé',
  'homepage.card.notLoaded': 'Non chargé',
  'homepage.card.busyRightNow': 'Actives maintenant',
  'homepage.card.currentModel': 'Modèle actuel',
  'homepage.card.contextWindow': 'Fenêtre de contexte',
  'homepage.card.notSet': 'Non défini',
  'homepage.card.unknownLimit': 'Inconnue',
  'homepage.card.historicalUsageNote': 'L\u2019usage historique est conservé par conversation et superposé à l\u2019état des sessions en direct ; les totaux ne dépendent plus de l\u2019ouverture préalable des conversations.',
  'homepage.card.backfillCompleted': ' Actualisé {{count}} résumé(s) en arrière-plan.',
  'homepage.card.unknownSubAgent': 'Sous-agent inconnu',
  'homepage.card.tasks': 'tâche(s)',
  'homepage.card.tokShort': 'tok',
  'homepage.card.historyLoadP95': 'Chargement historique p95',
  'homepage.card.coldSyncP95': 'Sync à froid p95',
  'homepage.card.flushP95': 'Flush p95',
  'homepage.card.slowEvents': 'Événements lents',
  'homepage.card.flushWaitP95': 'Attente flush p95',
  'homepage.card.patchPublishes': 'Patchs publiés',
  'homepage.card.telemetrySamples': 'Échantillons télémétrie',
  'homepage.card.perfLiveNote': 'Diagnostics en direct depuis le moteur du processus principal. Les chiffres proviennent des mêmes pipelines d\u2019hydratation et de patch que la vue de chat.',
  'homepage.card.perfEmptyHint': 'Aucune télémétrie de perf capturée pour l\u2019instant. Ouvrez une conversation, diffusez une réponse, puis revenez ici pour inspecter les temps du runtime.',

  // Tokens / agent / runtime misc
  'tokens.input': 'Entrée',
  'tokens.output': 'Sortie',
  'tokens.reasoning': 'Raisonnement',
  'tokens.cache': 'Cache',
  'provider.none': 'Aucun fournisseur',
  'agent.unknown': 'Inconnu',
  'thread.sandbox': 'Conversation sandbox',
  'runtime.source.settings': 'Remplacement paramètres',
  'runtime.source.default': 'Valeur par défaut config',
  'runtime.source.fallback': 'Valeur de repli',

  // Dashboard warnings
  'homepage.warning.dashboardFailed': 'Échec du chargement des totaux : {{error}}',
  'homepage.warning.backfillFailed': '{{count}} session(s) n\u2019ont pas pu être reconstruites — les totaux peuvent être sous-estimés.',
  'homepage.warning.backfillPending': 'Chargement en arrière-plan de {{count}} ancienne(s) session(s). Les totaux seront actualisés automatiquement.',

  // ────────────────────────────────────────────────────────────
  // Settings panel
  // ────────────────────────────────────────────────────────────
  'settings.title': 'Paramètres',
  'settings.subtitle': 'Ajustez l\u2019interface, le runtime du modèle et les autorisations locales.',
  'settings.done': 'Terminé',
  'settings.save': 'Enregistrer',
  'settings.saved': '✓ Enregistré',
  'settings.saveChanges': 'Enregistrer les modifications',
  'settings.saveHint': 'Les changements d\u2019apparence s\u2019appliquent immédiatement. Les changements de fournisseur et d\u2019autorisations redémarrent le runtime si nécessaire.',
  'settings.tab.appearance': 'Apparence',
  'settings.tab.appearanceDescription': 'Thème, schéma de couleurs et polices',
  'settings.tab.models': 'Modèles',
  'settings.tab.modelsDescription': 'Fournisseur, modèle et identifiants',
  'settings.tab.permissions': 'Autorisations',
  'settings.tab.permissionsDescription': 'Accès aux outils locaux',
  'settings.tab.storage': 'Stockage',
  'settings.tab.storageDescription': 'Artéfacts sandbox et nettoyage',
  'settings.tab.language': 'Langue',
  'settings.appearance.colorScheme': 'Schéma de couleurs',
  'settings.appearance.theme': 'Thème',
  'settings.appearance.themeActive': 'Actif',
  'settings.appearance.uiFont': 'Police d\u2019interface',
  'settings.appearance.monoFont': 'Police monospace',
  'settings.appearance.preview': 'Aperçu',
  'settings.appearance.previewHealth': 'État de l\u2019espace de travail',
  'settings.appearance.previewHealthDescription': 'Fournisseur connecté, runtime prêt',
  'settings.appearance.previewActive': 'Actif',
  'settings.appearance.previewMessage': 'Les changements de thème s\u2019appliquent immédiatement.',
  'settings.appearance.previewMessageSecondary': 'Les changements de fournisseur et d\u2019autorisations utilisent toujours le bouton d\u2019enregistrement ci-dessous.',
  'settings.models.provider': 'Fournisseur',
  'settings.models.model': 'Modèle',
  'settings.models.featured': 'Recommandé',
  'settings.models.allModels': 'Tous les modèles',
  'settings.models.refresh': 'Actualiser',
  'settings.models.refreshing': 'Actualisation…',
  'settings.models.refreshTitle': 'Actualiser le catalogue dynamique de modèles',
  'settings.models.search': 'Rechercher parmi {{count}} modèles…',
  'settings.models.noMatches': 'Aucun modèle ne correspond à cette recherche.',
  'settings.models.credentialsHeader': 'Identifiants',
  'settings.permissions.header': 'Outils développeur',
  'settings.permissions.bashTitle': 'Commandes shell',
  'settings.permissions.bashDescription': 'Permet aux agents d\u2019exécuter des commandes terminal dans l\u2019espace de travail actif.',
  'settings.permissions.fileWriteTitle': 'Édition de fichiers',
  'settings.permissions.fileWriteDescription': 'Permet aux agents de créer et modifier des fichiers dans l\u2019espace de travail local.',
  'settings.storage.loading': 'Chargement du stockage sandbox…',
  'settings.storage.diagnosticsHint': 'Utile pour signaler un problème — incluez ce rapport dans votre ticket.',
  'settings.storage.sandboxNote': 'Les conversations sandbox écrivent dans un espace de travail privé sous {{root}}. Les anciens espaces non référencés sont purgés automatiquement ; vous pouvez aussi lancer un nettoyage manuel.',
  'settings.updates.resetFailed': 'Impossible de réinitialiser les données : {{message}}',
  'settings.updates.resetCheckLogs': 'Échec de la réinitialisation. Consultez les journaux.',
  'settings.updates.checkFailedGeneric': 'Échec de la vérification des mises à jour.',

  'settings.language.label': 'Langue',
  'settings.language.description': 'Choisissez la langue de l\u2019interface. La sélection est mémorisée sur cet appareil. Les langues avec une traduction partielle afficheront les chaînes non traduites en anglais.',
  'settings.language.systemDefault': 'Détection automatique (système)',

  'settings.storage.supportDiagnostics': 'Diagnostics de support',
  'settings.storage.supportDescription': 'Copie un rapport en texte brut (configuration, entrées du runtime, journaux récents) dans votre presse-papiers. Les identifiants sont masqués afin que le rapport puisse être partagé.',
  'settings.storage.copyDiagnostics': 'Copier les diagnostics',
  'settings.storage.preparing': 'Préparation…',
  'settings.storage.copied': 'Copié dans le presse-papiers',
  'settings.storage.copyFailed': 'Impossible de générer les diagnostics — réessayez',
  'settings.storage.sandboxStorage': 'Stockage sandbox',
  'settings.storage.totalSize': 'Taille totale',
  'settings.storage.workspaces': 'Espaces de travail',
  'settings.storage.referenced': 'Référencés',
  'settings.storage.unreferenced': 'Non référencés',
  'settings.storage.stale': 'Obsolètes',
  'settings.storage.retention': 'Rétention',
  'settings.storage.retentionDays': '{{days}} jours',
  'settings.storage.cleanup': 'Nettoyage',
  'settings.storage.clearOld': 'Supprimer les anciens fichiers sandbox',
  'settings.storage.clearOldDescription': 'Supprime les espaces de travail sandbox non référencés de plus de {{days}} jours.',
  'settings.storage.clearAll': 'Supprimer tous les fichiers sandbox inutilisés',
  'settings.storage.clearAllDescription': 'Supprime tous les espaces de travail sandbox non référencés tout en conservant ceux des conversations actives.',
  'settings.storage.cleaning': 'Nettoyage…',
  'settings.storage.lastCleanup': 'Le dernier nettoyage a supprimé {{count}} espace(s) de travail et libéré {{size}}.',

  'settings.updates.header': 'Mises à jour',
  'settings.updates.checkForUpdates': 'Rechercher des mises à jour',
  'settings.updates.description': 'Interroge l\u2019API GitHub Releases pour connaître la dernière version publiée. Lecture seule — pas de téléchargement ni d\u2019installation automatique.',
  'settings.updates.checking': 'Vérification…',
  'settings.updates.newAvailable': 'Nouvelle version disponible : {{version}}',
  'settings.updates.upToDate': 'Vous utilisez la dernière version ({{version}})',
  'settings.updates.unavailable': 'Vérification des mises à jour indisponible',
  'settings.updates.failed': 'Impossible de vérifier les mises à jour',
  'settings.updates.hint': 'Ouvre la page de release GitHub si une version plus récente est disponible.',
  'settings.updates.currentHint': 'Vous êtes sur {{version}}. Cliquez ci-dessous pour voir les notes de version.',
  'settings.updates.openReleaseNotes': 'Ouvrir les notes de version',

  'settings.reset.header': 'Réinitialisation',
  'settings.reset.title': 'Réinitialiser toutes les données',
  'settings.reset.description': 'Supprime toutes les conversations, identifiants, agents personnalisés, compétences et MCP de cet appareil. L\u2019application redémarre sur l\u2019écran de premier lancement. Utile avant la désinstallation ou pour une démonstration à blanc ; irréversible.',
  'settings.reset.button': 'Réinitialiser les données',
  'settings.reset.resetting': 'Réinitialisation…',
  'settings.reset.requiresConfirm': 'Demande une confirmation explicite. L\u2019application va se fermer et redémarrer.',
  'settings.reset.confirm': 'Réinitialiser toutes les données ?\n\nCette action supprime toutes les conversations, identifiants, agents personnalisés, compétences et MCP de cet appareil. L\u2019application redémarrera sur l\u2019écran de premier lancement. Irréversible.',

  // ────────────────────────────────────────────────────────────
  // Agent builder
  // ────────────────────────────────────────────────────────────
  'agents.tab.skills': 'Compétences',
  'agents.tab.tools': 'Outils',
  'agents.tab.instructions': 'Instructions',
  'agents.tab.inference': 'Inférence',
  'agents.new': 'Nouvel agent',
  'agents.save': 'Enregistrer les modifications',
  'agents.create': 'Créer l\u2019agent',
  'agents.saving': 'Enregistrement…',
  'agents.openCapabilities': 'Besoin de plus d\u2019outils ou de compétences ?',
  'agents.openCapabilitiesLink': 'Ouvrir Capacités',

  // ────────────────────────────────────────────────────────────
  // Capabilities page
  // ────────────────────────────────────────────────────────────
  'capabilities.tab.tools': 'Outils',
  'capabilities.tab.skills': 'Compétences',
  'capabilities.addMcp': 'Ajouter un MCP',
  'capabilities.addSkill': 'Ajouter une compétence',
  'capabilities.noTools': 'Aucun outil disponible pour le moment. Ajoutez un MCP depuis la page Capacités.',
  'capabilities.noSkills': 'Aucune compétence disponible pour le moment. Ajoutez un lot de compétences depuis la page Capacités.',

  // ────────────────────────────────────────────────────────────
  // Chat
  // ────────────────────────────────────────────────────────────
  'chat.placeholder': 'Envoyez un message à {{brandName}}…',
  'chat.showContext': 'Afficher le contexte',
  'chat.hideContext': 'Masquer le contexte',
  'chat.thinking': 'Réflexion en cours…',

  // ────────────────────────────────────────────────────────────
  // ViewErrorBoundary
  // ────────────────────────────────────────────────────────────
  'error.viewError': 'Erreur de vue',
  'error.viewErrorTitle': 'Cette page n\u2019a pas pu s\u2019afficher.',
  'error.viewErrorBody': '{{brandName}} a récupéré le reste de l\u2019application. Retournez à l\u2019accueil et réessayez.',
  'error.backToHome': 'Retour à l\u2019accueil',

  // Chat — approval card
  'approval.sendEmail': 'Envoyer un e-mail',
  'approval.createSpreadsheet': 'Créer une feuille',
  'approval.createDocument': 'Créer un document',
  'approval.createPresentation': 'Créer une présentation',
  'approval.delete': 'Supprimer',
  'approval.shareFile': 'Partager un fichier',
  'approval.createEvent': 'Créer un événement',
  'approval.allowAction': 'Autoriser l\u2019action',
  'approval.deny': 'Refuser',
  'approval.approve': 'Approuver',

  // Chat — message actions
  'messageActions.branchHere': 'Brancher ici',
  'messageActions.branchHereDescription': 'Créer une nouvelle conversation qui s\u2019arrête à ce message',
  'messageActions.revertHere': 'Revenir ici',
  'messageActions.revertHereDescription': 'Revenir à l\u2019état juste avant ce message',
  'messageActions.viewDiff': 'Voir le diff',
  'messageActions.viewDiffDescription': 'Afficher les modifications de fichiers introduites par ce message',
  'messageActions.branchFailed': 'Impossible de brancher depuis ce message. Réessayez.',
  'messageActions.revertConfirm': 'Revenir à ce message ? Les tours suivants seront masqués jusqu\u2019à annulation.',
  'messageActions.revertFailed': 'Impossible de revenir à ce message. Réessayez.',

  // Chat — input composer
  'chat.attachFile': 'Joindre un fichier',
  'chat.planMode': 'Plan',
  'chat.buildMode': 'Build',
  'chat.planModeDescription': 'Mode Plan : analyse et audit en lecture seule',
  'chat.buildModeDescription': 'Mode Build : accès complet et délégation',
  'chat.forkThread': 'Dupliquer la conversation',
  'chat.stopGenerating': 'Arrêter la génération (Échap)',
  'chat.awaitingApproval': 'En attente d\u2019approbation',
  'chat.awaitingApprovalTitle': 'Approuvez ou refusez la demande d\u2019outil en attente pour continuer',
  'chat.awaitingAnswer': 'En attente de réponse',
  'chat.awaitingAnswerTitle': 'Répondez à la question en attente pour continuer',
  'chat.placeholder.answerPending': 'Répondez à la question ci-dessus pour continuer…',
  'chat.placeholder.askPlan': 'Demandez à Plan d\u2019analyser ou de structurer le travail…',
  'chat.placeholder.askBuild': 'Demandez à Build de travailler sur ceci…',
  'chat.placeholder.noThread': 'Ouvrez d\u2019abord une nouvelle conversation',

  // Chat — diff viewer
  'diff.changesFromMessage': 'Modifications depuis ce message',
  'diff.changes': 'Modifications',
  'diff.closeChanges': 'Fermer les modifications',
  'diff.loading': 'Chargement des modifications…',
  'diff.noChanges': 'Aucune modification de fichier dans cette session',
  'diff.filesChanged': '{{count}} fichier(s) modifié(s)',
  'diff.unified': 'Unifié',
  'diff.split': 'Séparé',
  'diff.noTextual': 'Aucun diff textuel disponible (fichier binaire, renommage ou espaces uniquement).',
  'diff.couldNotLoad': 'Impossible de charger le contenu du fichier',
  'diff.couldNotLoadWithError': 'Impossible de charger : {{error}}',
  'diff.showHiddenLines': 'Afficher {{count}} ligne(s) inchangée(s)',
  'diff.collapse': 'Réduire',
  'diff.statusNew': 'Nouveau',
  'diff.statusDeleted': 'Supprimé',
  'diff.statusModified': 'Modifié',

  // Chat — thinking indicator
  'thinking.buildCoordinating': 'Build coordonne',
  'thinking.planning': 'Planification',
  'thinking.generalWorking': 'General travaille',
  'thinking.exploreWorking': 'Explore travaille',
  'thinking.awaitingApproval': 'En attente de votre approbation',
  'thinking.buildCoordinatingCount': 'Build coordonne {{count}} agent(s)',
  'thinking.buildMerging': 'Build fusionne les résultats des agents',
  'thinking.agentWorking': '{{agent}} travaille',
  'thinking.thinking': 'Réflexion en cours',
  'thinking.compacting': 'Compactage de la conversation pour préserver le contexte…',
  'thinking.agentPlan': 'Plan de l\u2019agent',
  'thinking.sessionTodos': 'Tâches de la session',

  // Chat — compaction
  'compaction.running': 'Compactage',
  'compaction.done': 'Compacté',
  'compaction.causeOverflow': 'dépassement',
  'compaction.causeAuto': 'auto',
  'compaction.causeManual': 'manuel',
  'compaction.runningOverflow': 'Fenêtre de contexte dépassée — raccourcissement des anciens tours pour libérer de l\u2019espace.',
  'compaction.runningAuto': 'Approche de la limite de contexte — compactage proactif.',
  'compaction.runningManual': 'Résumé manuel de la session pour condenser les anciens tours.',
  'compaction.doneOverflow': 'Les anciens tours ont été résumés car la fenêtre de contexte était pleine.',
  'compaction.doneAuto': 'Les anciens tours ont été résumés automatiquement pour laisser de la place aux nouvelles réponses.',
  'compaction.doneManual': 'Les anciens tours ont été résumés manuellement.',

  // Chat — task status
  'taskStatus.running': 'en cours',
  'taskStatus.done': 'terminé',
  'taskStatus.errored': 'en erreur',
  'taskStatus.queued': 'en file',

  // Chat — mission control
  'missionControl.stuckTitle': 'Ce sous-agent tourne depuis un moment — parfois une requête web ou une réponse du fournisseur bloque. Utilisez le bouton d\u2019arrêt du composeur pour annuler toute l\u2019exécution.',
  'missionControl.slow': 'lent',
  'missionControl.deeperTitle': 'Ce sous-agent a lancé {{count}} sous-tâche(s) supplémentaire(s). Cliquez sur la voie pour explorer.',

  // Chat — task drill-in
  'taskDrillIn.backToParent': 'Retour à la tâche parente',
  'taskDrillIn.abortTask': 'Annuler cette tâche',
  'taskDrillIn.abortTaskDescription': 'Annule uniquement ce sous-agent ; les voisins et le principal continuent',
  'taskDrillIn.closeDrawer': 'Fermer le panneau',

  // Chat — question dock
  'questionDock.pendingCount': '{{count}} questions en attente sur cette conversation',
  'questionDock.scrollToToolCall': 'Faire défiler vers l\u2019appel d\u2019outil concerné',
  'questionDock.typeOwnAnswer': 'Saisissez votre propre réponse',

  // Chat — mermaid
  'mermaid.zoomOut': 'Dézoomer le diagramme Mermaid',
  'mermaid.resetZoom': 'Réinitialiser le zoom Mermaid',
  'mermaid.zoomIn': 'Zoomer sur le diagramme Mermaid',

  // Chat — model menu
  'chatModelMenu.selectModel': 'Sélectionner un modèle',
  'chatModelMenu.search': 'Rechercher un modèle…',

  // Agents — page
  'agentsPage.title': 'Agents',
  'agentsPage.subtitle': 'Composez des spécialistes à partir de compétences, d\u2019outils et d\u2019instructions. Cliquez sur une carte pour l\u2019ouvrir dans le constructeur.',
  'agentsPage.backToChat': 'Retour au chat',
  'agentsPage.search': 'Rechercher des agents, compétences, outils ou instructions…',
  'agentsPage.importTitle': 'Importer un agent personnalisé depuis un fichier .cowork-agent.json',
  'agentsPage.import': 'Importer',
  'agentsPage.importFailed': 'Impossible d\u2019importer {{filename}} : {{error}}',
  'agentsPage.importConflict': 'Un agent personnalisé nommé « {{name}} » existe déjà. Le remplacer par celui importé ?',

  // Agents — card
  'agentCard.editAvatar': 'Modifier l\u2019avatar de l\u2019agent',
  'agentCard.idPlaceholder': 'agent-id',
  'agentCard.descriptionPlaceholder': 'À quoi cet agent est-il spécialisé ?',
  'agentCard.enabledTitle': 'Visible dans le chat',
  'agentCard.disabledTitle': 'Désactivé — n\u2019apparaîtra pas dans le chat',
  'agentCard.removeLabel': 'Retirer {{label}}',
  'agentCard.missingTool': 'Outil manquant : {{label}}',

  // Agents — avatar editor
  'avatarEditor.setColor': 'Définir la couleur sur {{label}}',

  // Agents — skill / tool library
  'skillLibrary.empty': 'Aucune compétence disponible pour l\u2019instant. Ajoutez un lot de compétences depuis la page Capacités.',
  'skillLibrary.needsTools': 'Nécessite {{count}} outil(s)',
  'toolLibrary.empty': 'Aucun outil disponible pour l\u2019instant. Ajoutez un MCP depuis la page Capacités.',
  'toolLibrary.writeTooltip': 'Cet outil peut écrire — augmente l\u2019empreinte de l\u2019agent',
}

export const fr: LocaleCatalog = {
  locale: 'fr',
  nativeLabel: 'Français',
  strings,
}
