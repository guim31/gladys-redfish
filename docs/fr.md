# Redfish (iDRAC, iLO)

Les serveurs en rack ou en tour ont un contrôleur de gestion (BMC) qui les
surveille en permanence, même éteints : Dell iDRAC, HPE iLO, Lenovo
XClarity, Supermicro, OpenBMC… Tous parlent **Redfish**, l'API standard de
la DMTF. Cette intégration la lit : un appareil par serveur avec son état
de marche, sa santé, sa consommation, ses températures, ses ventilateurs et
ses alimentations. Les scènes peuvent réagir quand la santé se dégrade,
qu'une entrée critique apparaît dans le journal d'événements, ou qu'un
serveur s'allume ou s'éteint, et un widget résume vos serveurs sur le
tableau de bord. Le pilotage (allumage, arrêt propre, redémarrage) existe,
**désactivé par défaut**. Tout reste sur votre réseau local.

**Développée sans le matériel : vos retours sont les bienvenus.** Testée
contre le serveur de maquettes Redfish officiel de la DMTF (Docker) :
sessions, lectures des ressources Redfish anciennes et récentes, journaux
d'événements, action de reset. Les différences entre constructeurs (iLO 4,
iDRAC) viennent de leurs schémas documentés. Dites-nous comment ça se passe
sur votre serveur dans
[les issues](https://github.com/guim31/gladys-redfish/issues).

## Ce qu'il faut

- Gladys Assistant 5.1.0 ou plus récent.
- Un serveur dont le contrôleur a Redfish activé : iDRAC 8 (firmware 2.40 ou
  plus) ou iDRAC 9, iLO 4 (2.30 ou plus), iLO 5 ou iLO 6, Lenovo XClarity
  Controller, un BMC Supermicro récent, OpenBMC.
- Le contrôleur joignable depuis la machine Gladys en HTTPS (port 443).
- Un compte sur le contrôleur. Un compte en lecture seule suffit ; le
  pilotage demande un compte qui en a le droit (Operator sur un iDRAC,
  « Virtual Power and Reset » sur un iLO).
- Jusqu'à trois contrôleurs par installation de l'intégration.

## Mise en route

### 1. Préparer le contrôleur

- Vérifiez que l'interface web du contrôleur s'ouvre dans un navigateur
  (`https://<adresse du contrôleur>`).
- Redfish est actif par défaut sur les firmwares récents. Sur un iDRAC 8,
  vérifiez-le dans _iDRAC Settings → Services → Redfish_.
- Créez si possible un compte dédié, en lecture seule si vous ne voulez pas
  du pilotage.

### 2. Configurer l'intégration

Dans l'onglet **Configuration** de l'intégration :

- **Adresse du contrôleur** : `192.168.1.30`, `idrac.lan` ou
  `https://idrac.lan`. HTTPS est utilisé quand `http://` n'est pas précisé.
- **Nom d'utilisateur** et **Mot de passe** du compte du contrôleur.
- **Nom** (facultatif) : affiché dans le nom de l'appareil, le widget et les
  messages. Par défaut, le nom d'hôte donné par le contrôleur, sinon le
  modèle du serveur.
- Jusqu'à deux autres contrôleurs dans les sections suivantes.
- **Intervalle de rafraîchissement** : de 30 secondes à 5 minutes (1 minute
  par défaut). Les journaux d'événements sont lus toutes les 5 minutes.
- **Accepter les certificats auto-signés** : la plupart des contrôleurs ont
  un certificat auto-signé. Si votre navigateur avertit lui aussi, cochez
  cette option. La connexion reste chiffrée, mais l'identité du contrôleur
  n'est plus vérifiée : à faire seulement sur votre réseau local.
- **Autoriser le pilotage de l'alimentation** : voir
  [Pilotage](#pilotage). Désactivé par défaut.
- **Langue des noms** : langue des noms des fonctionnalités (fixés à l'ajout
  du serveur), des textes de santé et des résultats de scène.

Cliquez ensuite sur **Tester la connexion** : une ligne par contrôleur, avec
les serveurs trouvés et l'authentification utilisée.

### 3. Ajouter le serveur

Le serveur apparaît dans l'onglet **Découverte** de l'intégration :
ajoutez-le. Seuls les serveurs ajoutés reçoivent des valeurs ; le widget et
les déclencheurs de scène fonctionnent pour tous les serveurs, ajoutés ou
non.

## L'appareil

Un appareil par serveur (en général un par contrôleur ; un châssis à
plusieurs nœuds en donne un par nœud). Seules les fonctionnalités que le
contrôleur fournit sont proposées :

| Fonctionnalité                           | Valeur                                                          |
| ---------------------------------------- | --------------------------------------------------------------- |
| Alimentation                             | Allumé ou éteint. Un interrupteur si le pilotage est autorisé   |
| Santé                                    | OK, Avertissement ou Critique : la santé globale du contrôleur  |
| Consommation                             | Watts consommés par le serveur                                  |
| Température d'entrée                     | Air qui entre dans le serveur, en °C                            |
| Température processeur                   | Le processeur le plus chaud, en °C                              |
| Ventilateurs (tr/min) / Ventilateurs (%) | La vitesse moyenne des ventilateurs, dans l'unité du contrôleur |
| Alimentations en défaut                  | 0 quand tout va bien                                            |

L'appareil affiche aussi l'identifiant Redfish, le numéro de série et la
version du BIOS dans ses paramètres. Quand le contrôleur ne répond pas,
l'appareil porte le badge « injoignable » et le statut sous le nom de
l'intégration dit pourquoi.

## Tableau de bord

Le widget **Serveurs (Redfish)** a deux modes :

- **sans serveur choisi** : une ligne par serveur, allumé ou éteint, santé et
  consommation, en orange ou en rouge quand quelque chose ne va pas ;
- **avec un serveur choisi** : sa consommation, ses températures d'entrée et
  du processeur en tuiles, puis son alimentation, sa santé, ses ventilateurs
  et ses alimentations. Quand le pilotage est autorisé, les boutons
  **Éteindre** et **Redémarrer** (serveur allumé) ou **Allumer** (serveur
  éteint) apparaissent, chacun avec une confirmation.

**Actualiser** relit les contrôleurs.

## Scènes

### Déclencheurs

- **Santé du serveur dégradée** : la santé passe de OK à Avertissement ou
  Critique, ou d'Avertissement à Critique. Variables : serveur, santé.
- **Nouvelle entrée critique du journal** : une nouvelle entrée critique
  dans le journal d'événements (SEL sur un iDRAC, IEL et IML sur un iLO,
  EventLog sur OpenBMC). Lu toutes les 5 minutes ; trois au plus par
  lecture. Variables : serveur, message, date.
- **Serveur allumé** et **Serveur éteint** : quelle qu'en soit la cause
  (bouton, contrôleur, coupure de courant). Variable : serveur.

Chaque déclencheur peut être limité à un serveur. La première lecture après
l'installation ne fait qu'enregistrer les états : rien n'est annoncé pour une
entrée ou une santé qui était déjà là.

### Actions

- **État d'un serveur** : lit un serveur et donne aux actions suivantes son
  nom, si le contrôleur répond, l'état de marche, la santé, la consommation,
  les températures, la vitesse des ventilateurs, les alimentations en défaut,
  et un résumé prêt à envoyer (« web483 : allumé, santé OK, 344 W, entrée
  25 °C… »).
- **Commande d'alimentation** : allumage, arrêt propre, redémarrage ou
  redémarrage forcé (reset) d'un serveur. Demande **Autoriser le pilotage de
  l'alimentation**.

### Idées de scènes

- Quand la santé du serveur NAS se dégrade, envoyer son état sur Telegram
  avec **État d'un serveur**.
- À 1 h du matin, si personne n'est à la maison, **Commande d'alimentation**
  « Arrêt propre » sur le serveur de test ; à 7 h, « Allumer ».
- Quand une **Nouvelle entrée critique du journal** apparaît, prévenir avec
  son message.

## Pilotage

Désactivé par défaut. Une fois **Autoriser le pilotage de l'alimentation**
coché, cliquez sur **Mettre à jour** pour le serveur dans l'onglet
Découverte : la fonctionnalité **Alimentation** devient un interrupteur.

- Allumer envoie `On` (ou un appui court sur le bouton d'alimentation quand
  le contrôleur ne propose pas `On`).
- Éteindre envoie un **arrêt propre** (`GracefulShutdown`, ou un appui court
  sur un iLO 4 : le système d'exploitation s'arrête proprement). **Jamais
  d'arrêt forcé** : un interrupteur actionné par erreur, un assistant vocal
  ou une scène ne doivent pas couper un serveur.
- **Redémarrer** (widget, scène) est un redémarrage propre, quand le
  contrôleur le propose. Le redémarrage forcé (reset) n'existe que dans
  l'action de scène **Commande d'alimentation**, choisi explicitement.

Le serveur met un moment à changer d'état : il est relu 15 secondes après la
commande, puis à l'intervalle habituel.

## Dépannage

- **« certificat refusé »** : cochez **Accepter les certificats
  auto-signés**, ou installez sur le contrôleur un certificat reconnu.
- **« nom d'utilisateur ou mot de passe refusé »** : vérifiez le compte dans
  l'interface web du contrôleur. Certains contrôleurs bloquent un compte
  après quelques échecs.
- **« ne répond pas »** : vérifiez l'adresse, et que le port 443 du
  contrôleur est joignable depuis la machine Gladys (autre VLAN ?).
- **« aucun service Redfish à cette adresse »** : Redfish est désactivé, ou
  l'adresse n'est pas celle du contrôleur (les iDRAC 7 et plus anciens n'ont
  pas Redfish).
- **Une fonctionnalité manque** : le contrôleur ne la fournit pas (certains
  ventilateurs ou alimentations ne sont visibles que serveur allumé).
- **Une commande refusée** : le compte n'en a pas le droit, ou le contrôleur
  ne la propose pas (un iLO 4 n'a pas de redémarrage propre).

## Limites

- Développée sans le matériel : les différences entre constructeurs sont
  traitées d'après leurs schémas et les maquettes officielles, pas encore
  d'après de vrais serveurs.
- Un châssis par serveur : le premier lié au système. Les châssis lames et
  les systèmes multi-châssis n'affichent que celui-là.
- Le journal d'événements est lu par pages : sur un journal très long, une
  entrée entre la première et la dernière page peut être manquée.
- Le contrôleur est une petite puce : un intervalle sous la minute le
  charge, et certains firmwares journalisent chaque session.
- Les contrôleurs IPMI seuls (sans Redfish) ne sont pas pris en charge.

## Crédits

Les fixtures de test viennent des maquettes publiques du
[DMTF Redfish Mockup Server](https://github.com/DMTF/Redfish-Mockup-Server)
(BSD 3-Clause). Redfish est une marque de la DMTF. Cette intégration n'est
affiliée ni à Dell, ni à HPE, ni à Lenovo, ni à Supermicro, ni à la DMTF.
