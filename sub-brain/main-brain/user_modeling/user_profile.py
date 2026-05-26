"""User profile dataclass."""

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class UserProfile:
    """Structured user profile extracted from conversation history."""

    name: str = ""
    interests: List[str] = field(default_factory=list)
    communication_style: str = ""
    expertise_areas: List[str] = field(default_factory=list)
    preferred_tools: List[str] = field(default_factory=list)
    timezone: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "interests": self.interests,
            "communication_style": self.communication_style,
            "expertise_areas": self.expertise_areas,
            "preferred_tools": self.preferred_tools,
            "timezone": self.timezone,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "UserProfile":
        return cls(
            name=data.get("name", ""),
            interests=data.get("interests", []),
            communication_style=data.get("communication_style", ""),
            expertise_areas=data.get("expertise_areas", []),
            preferred_tools=data.get("preferred_tools", []),
            timezone=data.get("timezone"),
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
        )
