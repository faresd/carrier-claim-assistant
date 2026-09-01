(function initCarrierRules(root) {
  "use strict";

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function carrierFromTrackingNumber(value) {
    const trackingNumber = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (/^X[A-Z]\d{9}JB$/.test(trackingNumber)) {
      return { id: "chronopost", label: "Chronopost", supported: true, source: "tracking_number" };
    }
    if (/^(?:6A|9L|6C|9V|8R|8U|6G|6V|6H|9H|6M|9M|CM|CG|CI|8S|0M|1M|8B|8E|7E)\d{11}$/.test(trackingNumber)) {
      return { id: "laposte", label: "Colissimo", supported: true, source: "tracking_number" };
    }
    return null;
  }

  function detectCarrier(order) {
    const trackingCarrier = carrierFromTrackingNumber(order?.trackingNumber);
    if (trackingCarrier) {
      return {
        ...trackingCarrier,
        declaredCarrier: String(order?.carrier || "").trim(),
        labelMismatch: Boolean(order?.carrier) && !normalize(order.carrier).includes(normalize(trackingCarrier.label))
      };
    }
    const combined = normalize(`${order?.carrier || ""} ${order?.shippingService || ""}`);
    if (/chronopost|chrono\s*(?:10|13|18|classic|express|relais)|chronotrace/.test(combined)) {
      return { id: "chronopost", label: "Chronopost", supported: true, source: "carrier_label" };
    }
    if (/colissimo|colissimos|la\s*poste|laposte/.test(combined)) {
      return { id: "laposte", label: combined.includes("colissimo") ? "Colissimo" : "La Poste", supported: true, source: "carrier_label" };
    }
    return { id: "unknown", label: order?.carrier || "Unknown carrier", supported: false, source: "unknown" };
  }

  const MONTHS = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8,
    sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
  };

  function parseAmazonDate(value, useLastDate = false) {
    const matches = [...String(value || "").matchAll(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/g)];
    const match = useLastDate ? matches.at(-1) : matches[0];
    if (!match) return null;
    const month = MONTHS[match[2].toLowerCase()];
    if (month == null) return null;
    const date = new Date(Number(match[3]), month, Number(match[1]), useLastDate ? 23 : 0, useLastDate ? 59 : 0);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function ageInDays(order) {
    const sent = parseAmazonDate(order?.shipDate);
    return sent ? Math.max(0, Math.floor((Date.now() - sent.getTime()) / 86400000)) : null;
  }

  function overdueDays(order) {
    const due = parseAmazonDate(order?.deliverBy, true);
    return due ? Math.max(0, Math.floor((Date.now() - due.getTime()) / 86400000)) : null;
  }

  function statusAgeHours(result) {
    if (!result?.eventDate) return null;
    const date = new Date(result.eventDate);
    return Number.isNaN(date.getTime()) ? null : Math.max(0, Math.floor((Date.now() - date.getTime()) / 3600000));
  }

  const LAPOSTE_REASON_CONTRACT = Object.freeze({
    delayed: Object.freeze({ motif: "MOT073", sousmotif: "", label: "Arrived late / still delayed" }),
    delivered_missing: Object.freeze({ motif: "MOT093", sousmotif: "SMO298", label: "Marked delivered but not received" }),
    lost: Object.freeze({ motif: "MOT101", sousmotif: "SMO181", label: "Unlocated / not delivered" }),
    damaged: Object.freeze({ motif: "MOT063", sousmotif: "SMO179", label: "Damaged" }),
    returned: Object.freeze({ motif: "MOT039", sousmotif: "", label: "Returned to sender" })
  });

  function carrierReasonContract(carrierId, reason) {
    if (carrierId !== "laposte") return null;
    return LAPOSTE_REASON_CONTRACT[reason] || null;
  }

  const FEMININE_FIRST_NAMES = new Set([
    "alice", "amelie", "anja", "anna", "anne", "audrey", "beatrice", "birgit", "brigitte", "camille", "caroline",
    "catherine", "charlotte", "chloe", "claire", "clara", "danielle", "elena", "elisabeth", "emilie",
    "emma", "eva", "florence", "francoise", "gabrielle", "gisela", "heike", "helene", "ingrid", "isabelle", "jane", "jeanne",
    "jennifer", "jessica", "julie", "juliette", "karen", "katharina", "katrin", "laura", "lea", "linda", "louise", "lucie",
    "madeleine", "manon", "margaret", "maria", "marie", "marion", "mary", "melanie", "michelle", "monika",
    "nathalie", "nicole", "olivia", "patricia", "pauline", "rachel", "sabine", "samantha", "sandra", "sarah",
    "sophie", "stefanie", "stephanie", "susan", "suzanne", "sylvie", "ursula", "valerie", "victoria", "virginie", "zoe"
  ]);

  const MASCULINE_FIRST_NAMES = new Set([
    "adam", "alexandre", "andreas", "andrew", "anthony", "antoine", "arne", "benjamin", "bernard", "charles", "christian",
    "christophe", "daniel", "david", "denis", "dirk", "edward", "eric", "etienne", "francois", "frederic",
    "gabriel", "george", "gerard", "guillaume", "hans", "heinz", "henri", "hugo", "jacques", "james", "jan", "jean", "jens", "jeremy",
    "john", "jorg", "joseph", "julien", "jurgen", "kevin", "klaus", "laurent", "louis", "luc", "marc", "markus", "martin", "mathieu", "matthias",
    "matthew", "maxime", "michael", "michel", "nicolas", "olivier", "patrick", "paul", "peter", "philippe",
    "pierre", "ralf", "richard", "robert", "sebastien", "stefan", "stephen", "thomas", "thierry", "uwe", "vincent", "william", "wolfgang"
  ]);

  function detectRecipientTitle(recipientName) {
    const raw = String(recipientName || "").trim();
    const normalizedName = normalize(raw);
    if (/^(?:mme|madame|mrs|ms|miss|frau|senora|signora)\.?\s+/.test(normalizedName)) return "Madame";
    if (/^(?:m|mr|monsieur|herr|senor|signor)\.?\s+/.test(normalizedName)) return "Monsieur";
    const firstName = normalizedName
      .replace(/^(?:mme|madame|mrs|ms|miss|frau|senora|signora|m|mr|monsieur|herr|senor|signor)\.?\s+/, "")
      .split(/[\s'-]+/)[0];
    if (FEMININE_FIRST_NAMES.has(firstName)) return "Madame";
    if (MASCULINE_FIRST_NAMES.has(firstName)) return "Monsieur";
    return "";
  }

  const LAPOSTE_COUNTRY_LABELS = Object.freeze({
    australia: "Australie", austria: "Autriche", belgium: "Belgique", bulgaria: "Bulgarie", canada: "Canada",
    china: "Chine", croatia: "Croatie", cyprus: "Chypre", czechia: "République tchèque",
    "czech republic": "République tchèque", denmark: "Danemark", estonia: "Estonie", finland: "Finlande",
    france: "France", germany: "Allemagne", greece: "Grèce", "hong kong": "Hong Kong", hungary: "Hongrie",
    india: "Inde", ireland: "Irlande", eire: "Irlande", italy: "Italie", japan: "Japon", latvia: "Lettonie",
    lithuania: "Lituanie", luxembourg: "Luxembourg", malta: "Malte", netherlands: "Pays-Bas", norway: "Norvège",
    poland: "Pologne", portugal: "Portugal", romania: "Roumanie", slovakia: "Slovaquie", slovenia: "Slovénie",
    spain: "Espagne", sweden: "Suède", switzerland: "Suisse", "united arab emirates": "Émirats arabes unis",
    uae: "Émirats arabes unis", "united kingdom": "Royaume-Uni", uk: "Royaume-Uni", "great britain": "Royaume-Uni",
    "united states": "États-Unis", "united states of america": "États-Unis", usa: "États-Unis"
  });

  function laPosteCountryLabel(country) {
    return LAPOSTE_COUNTRY_LABELS[normalize(country)] || String(country || "").trim();
  }

  function firstLaPosteSubjectAnswerIndex(labels) {
    return (Array.isArray(labels) ? labels : []).findIndex((label) => {
      const text = normalize(label);
      return text &&
        text !== "retour" &&
        text !== "back" &&
        !text.includes("trigger stonly widget");
    });
  }

  function recommendClaim(order, result, settings = {}) {
    const carrier = detectCarrier(order);
    const statusText = String(result?.statusText || result?.summaryText || "").trim();
    const currentStatus = normalize(statusText);
    const status = normalize(`${statusText} ${result?.summaryText || ""}`);
    const shipmentAge = ageInDays(order);
    const overdue = overdueDays(order);
    const eventAge = statusAgeHours(result);
    const chronopostStaleHours = Number(settings.chronopostStaleHours || 48);
    const laposteOverdueDays = Number(settings.laposteOverdueDays || 7);
    const delivered = /(?:^|\b)(?:a (?:bien )?ete|est) livre\b|livraison (?:a ete )?effectuee|remis au destinataire|^livre\b|\bdelivered\b/.test(currentStatus) &&
      !/non livre|pas livre|jamais livre|impossible de livrer|n'a pas pu.*remis|n'avons pu.*remettre|echec de livraison|tentative de livraison/.test(currentStatus);

    const base = {
      carrier,
      statusText: statusText || "No readable carrier status was returned.",
      shipmentAgeDays: shipmentAge,
      overdueDays: overdue,
      statusAgeHours: eventAge,
      recommended: false,
      severity: "info",
      reason: "none",
      title: "No automatic claim recommended",
      explanation: "The current delivery state does not meet an automatic claim rule."
    };

    if (!carrier.supported) return { ...base, severity: "warning", title: "Carrier not supported", explanation: "Review this carrier manually." };
    if (result?.error) return { ...base, severity: "warning", title: "Status check needs review", explanation: result.error };
    if (/endommage|deteriore|avarie|damaged|damage/.test(status)) {
      return { ...base, recommended: true, severity: "high", reason: "damaged", title: "Damage claim recommended", explanation: "The carrier status indicates damage or an operational incident." };
    }
    if (/perdu|introuvable|egare|lost|missing|recherche infructueuse/.test(status)) {
      return { ...base, recommended: true, severity: "high", reason: "lost", title: "Loss claim recommended", explanation: "The carrier cannot locate the parcel." };
    }
    if (/retour a l'expediteur|retour expediteur|returned to sender|renvoye a l'expediteur/.test(status)) {
      return { ...base, recommended: true, severity: "high", reason: "returned", title: "Return claim recommended", explanation: "The carrier status indicates a return to sender." };
    }
    if (delivered) {
      return {
        ...base,
        reason: "delivered_missing",
        title: "Marked delivered",
        explanation: "No claim is proposed automatically. If the buyer confirms non-receipt, the matching complaint reason is already selected for review."
      };
    }

    if (carrier.id === "chronopost") {
      const stale = eventAge != null ? eventAge > chronopostStaleHours : (overdue != null ? overdue >= 2 : shipmentAge != null && shipmentAge >= 3);
      if (stale) return { ...base, recommended: true, severity: "high", reason: "delayed", title: "Chronopost investigation recommended", explanation: `The shipment appears unresolved beyond the ${chronopostStaleHours}-hour Chronopost threshold.` };
    }

    if (carrier.id === "laposte") {
      const pickupStale = /point de retrait|bureau de poste|mise a disposition|passage impossible|n'a pas pu.*remis|n'avons pu.*remettre/.test(status) && shipmentAge != null && shipmentAge >= 14;
      const late = overdue != null ? overdue >= laposteOverdueDays : shipmentAge != null && shipmentAge >= 10;
      if (pickupStale) return { ...base, recommended: true, severity: "high", reason: "lost", title: "Uncollected/unlocated parcel claim recommended", explanation: "The parcel has remained unresolved after an attempted delivery or pickup routing." };
      if (late) return { ...base, recommended: true, severity: "high", reason: "delayed", title: "Late delivery claim recommended", explanation: `The parcel is at least ${laposteOverdueDays} days beyond the configured delivery threshold.` };
    }

    if (/incident|retard|delay|acheminement|en transit|in transit|douane|customs/.test(status)) {
      return { ...base, severity: "warning", reason: "monitor", title: "Monitor carrier incident", explanation: "An issue is visible, but it has not crossed the configured automatic-claim threshold." };
    }
    return base;
  }

  function isTerminalDeliveredRecommendation(recommendation) {
    return recommendation?.recommended === false &&
      recommendation?.reason === "delivered_missing" &&
      recommendation?.title === "Marked delivered";
  }

  function dateFr(value) {
    const date = parseAmazonDate(value);
    return date ? date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }) : value || "date inconnue";
  }

  function buildClaimMessage(order, recommendation) {
    const status = String(recommendation.statusText || "").replace(/\s+/g, " ").trim();
    const value = order.itemValue || "valeur non détectée";
    const prefix = `Envoi ${order.trackingNumber}, expédié le ${dateFr(order.shipDate)} à ${order.recipientName} (${order.recipientCountry}).`;
    const messages = {
      damaged: `${prefix} Le suivi signale un dommage ou incident : « ${status.slice(0, 150)} ». Merci d'ouvrir une enquête et de nous indiquer la procédure d'indemnisation (valeur : ${value}).`,
      lost: `${prefix} Le colis n'a pas été livré et ne peut plus être localisé. Le suivi indique : « ${status.slice(0, 150)} ». Merci d'ouvrir une enquête et de procéder à l'indemnisation si la perte est confirmée (valeur : ${value}).`,
      returned: `${prefix} Le suivi indique un retour à l'expéditeur : « ${status.slice(0, 150)} ». Merci d'examiner cet incident et les possibilités d'indemnisation (valeur : ${value}).`,
      delayed: `${prefix} Le colis reste non livré au-delà du délai annoncé. Le suivi indique : « ${status.slice(0, 155)} ». Merci d'ouvrir une investigation et de nous communiquer une solution de livraison ou d'indemnisation (valeur : ${value}).`,
      delivered_missing: `${prefix} Le suivi indique que l'envoi a été livré, mais le destinataire confirme ne l'avoir reçu ni en boîte aux lettres ni en main propre. Statut affiché : « ${status.slice(0, 145)} ». Merci d'ouvrir une enquête de livraison et de nous communiquer la preuve de remise (valeur : ${value}).`
    };
    return (messages[recommendation.reason] || `${prefix} Merci d'examiner l'incident de livraison : « ${status.slice(0, 220)} ».`).slice(0, 500);
  }

  const api = {
    normalize,
    carrierFromTrackingNumber,
    detectCarrier,
    parseAmazonDate,
    ageInDays,
    overdueDays,
    recommendClaim,
    isTerminalDeliveredRecommendation,
    buildClaimMessage,
    carrierReasonContract,
    LAPOSTE_REASON_CONTRACT,
    detectRecipientTitle,
    laPosteCountryLabel,
    firstLaPosteSubjectAnswerIndex
  };
  root.CarrierClaimRules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
