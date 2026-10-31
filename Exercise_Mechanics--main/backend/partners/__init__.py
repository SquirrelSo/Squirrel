"""Partner Hunt — find people to train with.

Two inputs decide who a user sees: their own Partner Hunt preferences, and the Run Module's XP gate
(``meetsXPGate``), which a user must clear before they can browse or be browsed. Matching itself is
rule-based and explainable, in the same spirit as the exercise engine: every match carries the
reasons it scored the way it did.

Blocks are not Partner Hunt's: Social owns them (ADR-032), and every board asks it (social_blocks.py).
"""
