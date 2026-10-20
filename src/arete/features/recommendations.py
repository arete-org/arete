"""Intelligent training recommendations based on metrics.

Generates personalized recommendations based on:
- ACWR (injury risk)
- Monotony (training variation)
- Strain (overall stress)
- TSB (form/freshness)
- Ramp rate (progression speed)

References:
- Gabbett (2016) - Training-injury prevention paradox
- Foster (1998) - Monitoring overtraining
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal

from .fitness import FormZone, ReadinessLevel
from .workload import ACWRZone, MonotonyZone, StrainZone


class Priority(Enum):
    """Recommendation priority levels."""

    CRITICAL = "critical"  # Immediate action required
    HIGH = "high"  # Address soon
    MEDIUM = "medium"  # Consider implementing
    LOW = "low"  # Nice to have


class Category(Enum):
    """Recommendation categories."""

    VOLUME = "volume"  # Load adjustments
    INTENSITY = "intensity"  # Intensity adjustments
    RECOVERY = "recovery"  # Rest and recovery
    VARIETY = "variety"  # Training variation
    PROGRESSION = "progression"  # Safe progression
    PERFORMANCE = "performance"  # Peak performance


SportType = Literal["cardio", "strength", "mixed"]


@dataclass
class Recommendation:
    """A single training recommendation."""

    priority: Priority
    category: Category
    title: str
    message: str
    reason: str
    actions: list[str] = field(default_factory=list)


@dataclass
class WeekPlan:
    """Suggested training plan for the week."""

    target_sessions: int
    target_load: float
    distribution: str  # e.g., "2 intense, 1 modérée, 1 légère"
    focus: str
    deload_recommended: bool


@dataclass
class RecommendationReport:
    """Complete recommendation report."""

    recommendations: list[Recommendation]
    week_plan: WeekPlan | None
    risk_level: str  # "low", "medium", "high"
    primary_concern: str | None


# =============================================================================
# ACWR RECOMMENDATIONS
# =============================================================================


def _recommendations_acwr(
    acwr: float | None,
    acwr_zone: ACWRZone,
    sport_type: SportType,
) -> list[Recommendation]:
    """Generate recommendations based on ACWR."""
    recommendations = []

    if acwr is None:
        recommendations.append(
            Recommendation(
                priority=Priority.MEDIUM,
                category=Category.PROGRESSION,
                title="Données insuffisantes",
                message="Pas assez d'historique pour calculer l'ACWR",
                reason="L'ACWR nécessite 28 jours de données",
                actions=[
                    "Continuez à enregistrer vos séances",
                    "L'ACWR sera disponible après 4 semaines",
                ],
            )
        )
        return recommendations

    if acwr_zone == ACWRZone.DANGER:
        recommendations.append(
            Recommendation(
                priority=Priority.CRITICAL,
                category=Category.VOLUME,
                title="⚠️ ALERTE : Risque de blessure élevé",
                message=f"Votre ACWR ({acwr:.2f}) est dangereusement élevé",
                reason="Un ACWR > 1.5 multiplie le risque de blessure par 2-4",
                actions=[
                    "Réduisez immédiatement le volume de 30-40%",
                    "Privilégiez la récupération active",
                    "Évitez les séances intenses cette semaine",
                    "Surveillez les signes de fatigue",
                ],
            )
        )

    elif acwr_zone == ACWRZone.CAUTION:
        recommendations.append(
            Recommendation(
                priority=Priority.HIGH,
                category=Category.VOLUME,
                title="Zone de vigilance",
                message=f"Votre ACWR ({acwr:.2f}) indique une charge élevée",
                reason="ACWR entre 1.3 et 1.5 : progression rapide mais risquée",
                actions=[
                    "Stabilisez le volume cette semaine",
                    "Alternez séances intenses et légères",
                    "Surveillez votre récupération",
                ],
            )
        )

    elif acwr_zone == ACWRZone.OPTIMAL:
        recommendations.append(
            Recommendation(
                priority=Priority.LOW,
                category=Category.PROGRESSION,
                title="✅ Zone optimale",
                message=f"Votre ACWR ({acwr:.2f}) est dans la zone idéale",
                reason="ACWR 0.8-1.3 : équilibre parfait charge/récupération",
                actions=[
                    "Continuez sur cette lancée",
                    "Vous pouvez progresser de 5-10% par semaine",
                ],
            )
        )

    elif acwr_zone == ACWRZone.UNDERTRAINED:
        recommendations.append(
            Recommendation(
                priority=Priority.MEDIUM,
                category=Category.PROGRESSION,
                title="Sous-entraînement détecté",
                message=f"Votre ACWR ({acwr:.2f}) est faible",
                reason="ACWR < 0.8 : risque de désentraînement",
                actions=[
                    "Augmentez progressivement le volume (+10-15%/semaine)",
                    "Ajoutez une séance supplémentaire",
                    "Augmentez légèrement l'intensité",
                ],
            )
        )

    return recommendations


# =============================================================================
# MONOTONY RECOMMENDATIONS
# =============================================================================


def _recommendations_monotony(
    monotony: float | None,
    monotony_zone: MonotonyZone | None,
    sport_type: SportType,
) -> list[Recommendation]:
    """Generate recommendations based on monotony."""
    recommendations: list[Recommendation] = []

    if monotony is None or monotony_zone is None:
        return recommendations

    if monotony_zone == MonotonyZone.HIGH:
        if sport_type == "cardio":
            actions = [
                "Ajoutez une séance d'intervalles",
                "Variez les intensités (une longue sortie facile + une séance intense)",
                "Changez de type d'activité (vélo si vous courez habituellement)",
                "Intégrez du fractionné court et long",
            ]
        elif sport_type == "strength":
            actions = [
                "Alternez entre séances lourdes et légères",
                "Variez les plages de répétitions (force 3-5, hypertrophie 8-12)",
                "Intégrez des techniques différentes (tempo, pauses, clusters)",
                "Changez l'ordre des exercices",
            ]
        else:
            actions = [
                "Alternez cardio et musculation",
                "Variez l'intensité de vos séances",
                "Ajoutez de la diversité dans vos activités",
            ]

        recommendations.append(
            Recommendation(
                priority=Priority.HIGH,
                category=Category.VARIETY,
                title="⚠️ Entraînement trop monotone",
                message=f"Monotonie ({monotony:.2f}) : vos séances sont trop similaires",
                reason="Monotonie > 2.0 augmente le risque de blessure et surmenage",
                actions=actions,
            )
        )

    elif monotony_zone == MonotonyZone.ACCEPTABLE:
        recommendations.append(
            Recommendation(
                priority=Priority.MEDIUM,
                category=Category.VARIETY,
                title="Variabilité acceptable",
                message=f"Monotonie ({monotony:.2f}) : légèrement élevée",
                reason="Monotonie 1.5-2.0 : un peu plus de variation serait bénéfique",
                actions=[
                    "Pensez à varier l'intensité entre les séances",
                    "Alternez jours faciles et difficiles",
                ],
            )
        )

    return recommendations


# =============================================================================
# STRAIN RECOMMENDATIONS
# =============================================================================


def _recommendations_strain(
    strain: float | None,
    strain_zone: StrainZone | None,
) -> list[Recommendation]:
    """Generate recommendations based on training strain."""
    recommendations: list[Recommendation] = []

    if strain is None or strain_zone is None:
        return recommendations

    if strain_zone == StrainZone.CRITICAL:
        recommendations.append(
            Recommendation(
                priority=Priority.CRITICAL,
                category=Category.RECOVERY,
                title="⚠️ ALERTE : Strain critique",
                message=f"Strain ({strain:.0f}) : risque élevé de maladie/blessure",
                reason="Strain > 6000 est associé à une augmentation des maladies",
                actions=[
                    "Réduisez drastiquement la charge (déload)",
                    "Priorisez le sommeil (8h+)",
                    "Surveillez les signes de fatigue",
                    "Considérez un jour de repos complet",
                ],
            )
        )

    elif strain_zone == StrainZone.HIGH:
        recommendations.append(
            Recommendation(
                priority=Priority.HIGH,
                category=Category.RECOVERY,
                title="Strain élevé",
                message=f"Strain ({strain:.0f}) : charge importante cette semaine",
                reason="Strain 4000-6000 : fatigue accumulée",
                actions=[
                    "Planifiez des jours de récupération",
                    "Réduisez l'intensité des prochaines séances",
                    "Optimisez votre récupération (sommeil, nutrition)",
                ],
            )
        )

    return recommendations


# =============================================================================
# TSB/FORM RECOMMENDATIONS
# =============================================================================


def _recommendations_form(
    tsb: float,
    form_zone: FormZone,
    readiness: ReadinessLevel,
) -> list[Recommendation]:
    """Generate recommendations based on form (TSB)."""
    recommendations = []

    if form_zone == FormZone.EXHAUSTED:
        recommendations.append(
            Recommendation(
                priority=Priority.CRITICAL,
                category=Category.RECOVERY,
                title="⚠️ Fatigue extrême",
                message=f"TSB ({tsb:.0f}) : vous accumulez trop de fatigue",
                reason="TSB < -25 indique un surmenage potentiel",
                actions=[
                    "Semaine de décharge obligatoire",
                    "Réduisez le volume de 50%",
                    "Priorisez le sommeil et la nutrition",
                    "Évitez tout entraînement intense",
                ],
            )
        )

    elif form_zone == FormZone.TIRED:
        recommendations.append(
            Recommendation(
                priority=Priority.MEDIUM,
                category=Category.RECOVERY,
                title="Fatigue accumulée",
                message=f"TSB ({tsb:.0f}) : la fatigue s'accumule",
                reason="TSB entre -25 et -10 : phase de charge",
                actions=[
                    "C'est normal en phase de charge",
                    "Planifiez une semaine de récupération bientôt",
                    "Surveillez les signes de surentraînement",
                ],
            )
        )

    elif form_zone == FormZone.FRESH:
        recommendations.append(
            Recommendation(
                priority=Priority.LOW,
                category=Category.PERFORMANCE,
                title="✅ Forme optimale",
                message=f"TSB ({tsb:.0f}) : vous êtes frais et prêt",
                reason="TSB entre 10 et 25 : idéal pour performer",
                actions=[
                    "Bon moment pour un test ou une compétition",
                    "Vous pouvez maintenir ce niveau quelques jours",
                    "Profitez de cette forme !",
                ],
            )
        )

    elif form_zone == FormZone.FRESHEST:
        recommendations.append(
            Recommendation(
                priority=Priority.MEDIUM,
                category=Category.PROGRESSION,
                title="Très frais - risque de perte de forme",
                message=f"TSB ({tsb:.0f}) : possible désentraînement",
                reason="TSB > 25 : vous pourriez perdre en condition",
                actions=[
                    "Reprenez progressivement l'entraînement",
                    "Bon moment pour un pic de forme puis reprendre",
                    "Ne restez pas trop longtemps à ce niveau",
                ],
            )
        )

    return recommendations


# =============================================================================
# RAMP RATE RECOMMENDATIONS
# =============================================================================


def _recommendations_ramp_rate(ramp_rate: float | None) -> list[Recommendation]:
    """Generate recommendations based on CTL ramp rate."""
    recommendations: list[Recommendation] = []

    if ramp_rate is None:
        return recommendations

    if ramp_rate > 10:
        recommendations.append(
            Recommendation(
                priority=Priority.CRITICAL,
                category=Category.PROGRESSION,
                title="⚠️ Progression trop rapide",
                message=f"Ramp rate ({ramp_rate:.1f} pts/semaine) : trop agressif",
                reason="Ramp > 10 pts/semaine multiplie le risque de blessure",
                actions=[
                    "Réduisez immédiatement la progression",
                    "Stabilisez la charge 1-2 semaines",
                    "Maximum recommandé : 5-7 pts/semaine",
                ],
            )
        )

    elif ramp_rate > 7:
        recommendations.append(
            Recommendation(
                priority=Priority.HIGH,
                category=Category.PROGRESSION,
                title="Progression rapide",
                message=f"Ramp rate ({ramp_rate:.1f} pts/semaine) : élevé",
                reason="Ramp > 7 pts/semaine : progression agressive",
                actions=[
                    "Surveillez votre récupération",
                    "Envisagez de stabiliser bientôt",
                    "Restez attentif aux signes de fatigue",
                ],
            )
        )

    elif ramp_rate < -5:
        recommendations.append(
            Recommendation(
                priority=Priority.MEDIUM,
                category=Category.PROGRESSION,
                title="Charge en diminution",
                message=f"Ramp rate ({ramp_rate:.1f} pts/semaine) : baisse significative",
                reason="Votre forme de fond (CTL) diminue",
                actions=[
                    "Normal si vous êtes en décharge",
                    "Sinon, reprenez progressivement",
                ],
            )
        )

    return recommendations


# =============================================================================
# WEEK PLAN GENERATION
# =============================================================================


def generate_week_plan(
    acwr_zone: ACWRZone,
    strain_zone: StrainZone | None,
    form_zone: FormZone | None,
    chronic_load: float,
    sport_type: SportType,
) -> WeekPlan:
    """Generate a suggested training plan for the week."""

    # Determine if deload is needed
    deload_needed = (
        acwr_zone == ACWRZone.DANGER
        or strain_zone == StrainZone.CRITICAL
        or form_zone == FormZone.EXHAUSTED
    )

    if deload_needed:
        return WeekPlan(
            target_sessions=2,
            target_load=chronic_load * 0.5,
            distribution="2 séances légères",
            focus="Récupération et régénération",
            deload_recommended=True,
        )

    if acwr_zone == ACWRZone.UNDERTRAINED:
        return WeekPlan(
            target_sessions=4,
            target_load=chronic_load * 1.15,
            distribution="1 intense, 2 modérées, 1 légère",
            focus="Progression graduelle du volume",
            deload_recommended=False,
        )

    if acwr_zone == ACWRZone.CAUTION or strain_zone == StrainZone.HIGH:
        return WeekPlan(
            target_sessions=3,
            target_load=chronic_load * 0.85,
            distribution="1 modérée, 2 légères",
            focus="Stabilisation et récupération",
            deload_recommended=False,
        )

    # Optimal zone
    if sport_type == "cardio":
        distribution = "1 longue, 1 intervalles, 1 tempo, 1 récup"
    elif sport_type == "strength":
        distribution = "2 lourdes, 1 volume, 1 technique"
    else:
        distribution = "2 intenses, 1 modérée, 1 légère"

    return WeekPlan(
        target_sessions=4,
        target_load=chronic_load * 1.05,
        distribution=distribution,
        focus="Progression optimale",
        deload_recommended=False,
    )


# =============================================================================
# MAIN RECOMMENDATION ENGINE
# =============================================================================


def generate_recommendations(
    acwr: float | None,
    acwr_zone: ACWRZone,
    monotony: float | None,
    monotony_zone: MonotonyZone | None,
    strain: float | None,
    strain_zone: StrainZone | None,
    tsb: float | None = None,
    form_zone: FormZone | None = None,
    readiness: ReadinessLevel | None = None,
    ramp_rate: float | None = None,
    chronic_load: float = 0,
    sport_type: SportType = "mixed",
) -> RecommendationReport:
    """Generate complete training recommendations.

    Args:
        acwr: Acute:Chronic Workload Ratio
        acwr_zone: ACWR interpretation zone
        monotony: Training monotony value
        monotony_zone: Monotony interpretation zone
        strain: Training strain value
        strain_zone: Strain interpretation zone
        tsb: Training Stress Balance (optional)
        form_zone: Form interpretation zone (optional)
        readiness: Readiness level (optional)
        ramp_rate: Weekly CTL change (optional)
        chronic_load: Current chronic load (for week plan)
        sport_type: Type of sport for specific recommendations

    Returns:
        RecommendationReport with all recommendations and week plan
    """
    recommendations: list[Recommendation] = []

    # Gather all recommendations
    recommendations.extend(_recommendations_acwr(acwr, acwr_zone, sport_type))
    recommendations.extend(
        _recommendations_monotony(monotony, monotony_zone, sport_type)
    )
    recommendations.extend(_recommendations_strain(strain, strain_zone))

    if tsb is not None and form_zone is not None:
        recommendations.extend(
            _recommendations_form(tsb, form_zone, readiness or ReadinessLevel.MODERATE)
        )

    recommendations.extend(_recommendations_ramp_rate(ramp_rate))

    # Sort by priority
    priority_order = {
        Priority.CRITICAL: 0,
        Priority.HIGH: 1,
        Priority.MEDIUM: 2,
        Priority.LOW: 3,
    }
    recommendations.sort(key=lambda r: priority_order[r.priority])

    # Determine overall risk level
    if any(r.priority == Priority.CRITICAL for r in recommendations):
        risk_level = "high"
    elif any(r.priority == Priority.HIGH for r in recommendations):
        risk_level = "medium"
    else:
        risk_level = "low"

    # Primary concern
    primary_concern = None
    if recommendations:
        critical_recs = [r for r in recommendations if r.priority == Priority.CRITICAL]
        if critical_recs:
            primary_concern = critical_recs[0].title
        elif recommendations:
            high_recs = [r for r in recommendations if r.priority == Priority.HIGH]
            if high_recs:
                primary_concern = high_recs[0].title

    # Generate week plan
    week_plan = generate_week_plan(
        acwr_zone=acwr_zone,
        strain_zone=strain_zone,
        form_zone=form_zone,
        chronic_load=chronic_load,
        sport_type=sport_type,
    )

    return RecommendationReport(
        recommendations=recommendations,
        week_plan=week_plan,
        risk_level=risk_level,
        primary_concern=primary_concern,
    )
