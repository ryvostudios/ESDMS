export function toDetailDto(gatePass, items = [], auditLog = [], documentReady = false) {
  return {
    id: gatePass.id,
    gatePassNumber: gatePass.gate_pass_number,
    status: gatePass.status,
    // Whether the APPROVED_PDF file actually exists yet — distinct from
    // status APPROVED-or-later, since PDF generation is an async
    // background job (see gate-pass.service.js processApprovalPdfJob).
    // The frontend must gate "View PDF" on this, not on status alone.
    documentReady,
    issuingDepartmentId: gatePass.issuing_department_id,
    issuingDepartmentName: gatePass.issuing_department_name,
    requestedBy: gatePass.requested_by,
    destination: gatePass.destination,
    driverName: gatePass.driver_name,
    driverPhone: gatePass.driver_phone,
    vehicleRegistration: gatePass.vehicle_registration,
    // Provenance only: which master rows were chosen. The name/phone/
    // registration above stay the historical record and are never re-read
    // from these ids — see gate-pass.service.js applyFleetSelection.
    driverId: gatePass.driver_id ?? null,
    vehicleId: gatePass.vehicle_id ?? null,
    jobOrderId: gatePass.job_order_id,
    purpose: gatePass.purpose,
    expectedReturnDate: gatePass.expected_return_date,
    remarks: gatePass.remarks,
    createdByUserId: gatePass.created_by_user_id,
    createdByName: gatePass.created_by_name,
    approvedByUserId: gatePass.approved_by_user_id,
    approvedByName: gatePass.approved_by_name,
    approvedAt: gatePass.approved_at,
    rejectedAt: gatePass.rejected_at,
    rejectionReason: gatePass.rejection_reason,
    cancelledAt: gatePass.cancelled_at,
    cancellationReason: gatePass.cancellation_reason,
    departureOdometer: gatePass.departure_odometer,
    departureAt: gatePass.departure_at,
    returnOdometer: gatePass.return_odometer,
    returnAt: gatePass.return_at,
    returnRemarks: gatePass.return_remarks,
    distanceKm: gatePass.distance_km,
    // Metadata only — never a storage path. "View Photo" downloads through
    // the existing authorized GET /:id/files/:fileId endpoint, which
    // re-checks scope and file ownership itself; this id is not a
    // capability on its own.
    departureEvidence: gatePass.departure_photo_file_id
      ? {
          fileId: gatePass.departure_photo_file_id,
          odometer: gatePass.departure_odometer,
          recordedAt: gatePass.departure_at,
          recordedByUserId: gatePass.departure_by_user_id,
          recordedByName: gatePass.departure_by_name,
        }
      : null,
    returnEvidence: gatePass.return_photo_file_id
      ? {
          fileId: gatePass.return_photo_file_id,
          odometer: gatePass.return_odometer,
          recordedAt: gatePass.return_at,
          recordedByUserId: gatePass.return_by_user_id,
          recordedByName: gatePass.return_by_name,
        }
      : null,
    createdAt: gatePass.created_at,
    updatedAt: gatePass.updated_at,
    items: items.map((item) => ({
      id: item.id,
      lineNo: item.line_no,
      description: item.description,
      partNumber: item.part_number,
      quantity: Number(item.quantity),
      unit: item.unit,
    })),
    auditLog: auditLog.map((entry) => ({
      id: entry.id,
      action: entry.action,
      previousStatus: entry.previous_status,
      newStatus: entry.new_status,
      actorName: entry.actor_name,
      metadata: entry.metadata,
      createdAt: entry.created_at,
    })),
  };
}

// Data-minimized: only what a Guard needs at the gate.
export function toGuardDto(gatePass) {
  return {
    id: gatePass.id,
    gatePassNumber: gatePass.gate_pass_number,
    status: gatePass.status,
    destination: gatePass.destination,
    driverName: gatePass.driver_name,
    driverPhone: gatePass.driver_phone,
    vehicleRegistration: gatePass.vehicle_registration,
    purpose: gatePass.purpose,
    expectedReturnDate: gatePass.expected_return_date,
    approvedAt: gatePass.approved_at,
    departureAt: gatePass.departure_at,
    departureOdometer: gatePass.departure_odometer,
    returnAt: gatePass.return_at,
  };
}
